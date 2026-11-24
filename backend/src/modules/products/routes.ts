import { z } from "zod";
import type { Route } from "../../core/types";
import type { Queryable } from "../../db/pool";
import { HttpError } from "../../utils/httpError";
import { parseInput } from "../../utils/parseInput";

// Contrato 6.3. El menú es configuración del restaurante, por eso lo atiende
// la Lambda Lectura y Configuración.

const PRODUCT_LIMIT = 200;

// Mismo formato de dinero del contrato: "35", "35.5" o "35.50", menor a 100000.
const price = z.string().regex(/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/, "Precio inválido");
const name = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => v === v.trim() && v.trim() !== "", "Sin espacios en los extremos");
const description = z.string().max(500).nullable();

const createSchema = z.strictObject({
  name,
  description: description.optional(),
  price,
  isAvailable: z.boolean().default(true),
});

const patchSchema = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    price: price.optional(),
    isAvailable: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Envía al menos un campo");

const listQuerySchema = z.object({
  available: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price: string;
  is_available: boolean;
  created_at: Date;
}

const COLUMNS = `id, name, description, price::text AS price, is_available, created_at`;

function toProduct(r: ProductRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    price: r.price,
    isAvailable: r.is_available,
    createdAt: r.created_at,
  };
}

const notFound = () => new HttpError(404, "NOT_FOUND", "Recurso no encontrado");

async function lockRestaurant(tx: Queryable, restaurantId: string): Promise<void> {
  // Turna las creaciones simultáneas del mismo restaurante: así dos admins no
  // pueden pasar a la vez el tope de 200 productos.
  await tx.query(`SELECT 1 FROM restaurants WHERE id = $1 FOR UPDATE`, [restaurantId]);
}

export const productRoutes: readonly Route[] = [
  {
    method: "GET",
    resource: "/api/v1/products",
    async handle(db, req) {
      const { available } = parseInput(listQuerySchema, req.query, "query");
      const isAdmin = req.identity.role === "admin";
      if (!isAdmin && available === false) {
        throw new HttpError(403, "FORBIDDEN", "Solo el admin ve los productos no disponibles");
      }
      // El admin ve todos (o filtra); los demás solo los disponibles.
      const onlyAvailable = isAdmin ? available : true;
      const params: unknown[] = [req.identity.restaurantId];
      let where = "restaurant_id = $1";
      if (onlyAvailable !== undefined) {
        params.push(onlyAvailable);
        where += ` AND is_available = $2`;
      }
      const { rows } = await db.query<ProductRow>(
        `SELECT ${COLUMNS} FROM products WHERE ${where} ORDER BY name, id`,
        params,
      );
      return { status: 200, body: { data: rows.map(toProduct) } };
    },
  },
  {
    method: "POST",
    resource: "/api/v1/products",
    roles: ["admin"],
    write: true,
    async handle(db, req) {
      const input = parseInput(createSchema, req.body);
      const restaurantId = req.identity.restaurantId;
      const product = await db.transaction(async (tx) => {
        await lockRestaurant(tx, restaurantId);
        const { rows: count } = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM products WHERE restaurant_id = $1`,
          [restaurantId],
        );
        if (count[0]!.count >= PRODUCT_LIMIT) {
          throw new HttpError(409, "PRODUCT_LIMIT_REACHED", "Se alcanzó el tope de 200 productos");
        }
        const { rows } = await tx.query<ProductRow>(
          `INSERT INTO products (restaurant_id, name, description, price, is_available)
           VALUES ($1, $2, $3, $4::numeric, $5)
           RETURNING ${COLUMNS}`,
          [restaurantId, input.name, input.description ?? null, input.price, input.isAvailable],
        );
        return rows[0]!;
      });
      return { status: 201, body: toProduct(product) };
    },
  },
  {
    method: "PATCH",
    resource: "/api/v1/products/{id}",
    roles: ["admin"],
    write: true,
    async handle(db, req) {
      const id = String(req.params.id);
      if (!z.guid().safeParse(id).success) throw notFound();
      const input = parseInput(patchSchema, req.body);

      // Solo se actualizan los campos enviados; los nombres de columna son fijos.
      const columns: Record<string, string> = {
        name: "name",
        description: "description",
        price: "price",
        isAvailable: "is_available",
      };
      const params: unknown[] = [req.identity.restaurantId, id];
      const sets: string[] = [];
      for (const [field, value] of Object.entries(input)) {
        if (value === undefined) continue;
        params.push(value);
        const cast = field === "price" ? "::numeric" : "";
        sets.push(`${columns[field]} = $${params.length}${cast}`);
      }

      const { rows } = await db.query<ProductRow>(
        `UPDATE products SET ${sets.join(", ")}
          WHERE restaurant_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        params,
      );
      // Un producto de otro restaurante tampoco aparece: mismo 404.
      if (rows.length === 0) throw notFound();
      return { status: 200, body: toProduct(rows[0]!) };
    },
  },
];
