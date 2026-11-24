import { z } from "zod";

const orderItemSchema = z.strictObject({
  productId: z.guid(),
  quantity: z.int().min(1).max(99),
  notes: z.string().trim().max(200).nullable().optional(),
});

// En local: tableLabel obligatorio. Delivery: deliveryAddress obligatoria y
// sin tableLabel. Por defecto el pedido es para consumir en el local.
export const createOrderSchema = z
  .strictObject({
    serviceType: z.enum(["dine_in", "delivery"]).default("dine_in"),
    tableLabel: z.string().trim().min(1).max(30).optional(),
    deliveryAddress: z.string().trim().min(1).max(300).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    items: z.array(orderItemSchema).min(1).max(50),
  })
  .superRefine((o, ctx) => {
    if (o.serviceType === "dine_in") {
      if (o.tableLabel === undefined) {
        ctx.addIssue({ code: "custom", path: ["tableLabel"], message: "La mesa es obligatoria" });
      }
      if (o.deliveryAddress !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryAddress"],
          message: "Un pedido en local no lleva dirección",
        });
      }
    } else {
      if (o.deliveryAddress === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryAddress"],
          message: "La dirección es obligatoria",
        });
      }
      if (o.tableLabel !== undefined) {
        ctx.addIssue({ code: "custom", path: ["tableLabel"], message: "Un delivery no lleva mesa" });
      }
    }
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// Cabecera opcional Idempotency-Key: 1 a 100 caracteres ASCII visibles
// (por ejemplo, un UUID que el frontend genera una vez por pedido).
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,100}$/, "Idempotency-Key inválida")
  .optional();

const orderStatuses = [
  "pending",
  "preparing",
  "ready",
  "closed",
  "cancelled",
] as const;

export const listOrdersQuerySchema = z.object({
  status: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(z.enum(orderStatuses)).min(1))
    .optional(),
  mine: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z.enum(["createdAt", "-createdAt"]).default("-createdAt"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// Acciones sin cuerpo: se acepta vacío, pero no campos desconocidos.
export const emptyBodySchema = z.strictObject({});

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, "Monto inválido")
  .refine((v) => Number(v) > 0, "El monto debe ser mayor que 0");

export const paymentSchema = z.strictObject({
  method: z.enum(["cash", "card", "digital_wallet"]),
  amount: moneySchema,
});

export type PaymentInput = z.infer<typeof paymentSchema>;