import { z } from "zod";
import { HttpError, type ErrorDetail } from "./httpError";

// Mensajes de validación de Zod en español para toda la app.
z.config(z.locales.es());

// Convierte la ruta de Zod a la notación del contrato: items[0].quantity
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}

// Valida `data` contra el esquema. Si es válido, devuelve los datos tipados.
// Si no, lanza 400 VALIDATION_ERROR con los details del contrato.
// `rootField` nombra el campo cuando el error está en la raíz (por ejemplo,
// un cuerpo que no es un objeto): "body" por defecto, "query" para parámetros.
export function parseInput<T extends z.ZodType>(
  schema: T,
  data: unknown,
  rootField = "body",
): z.output<T> {
  const result = schema.safeParse(data);

  if (result.success) {
    return result.data;
  }

  const details: ErrorDetail[] = result.error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        field: formatPath([...issue.path, key]),
        message: "Campo no permitido",
      }));
    }
    return [
      {
        field: formatPath(issue.path) || rootField,
        message: issue.message,
      },
    ];
  });

  throw new HttpError(400, "VALIDATION_ERROR", "Datos inválidos", details);
}