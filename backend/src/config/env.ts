import { z } from "zod";

// Una variable opcional vacía (COGNITO_CLIENT_ID=) cuenta como "no definida".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z
      .string()
      .regex(
        /^postgres(ql)?:\/\/.+/,
        "debe empezar con postgresql:// o postgres://",
      ),
    // Instancia de lectura de Aurora (endpoint de solo lectura de RDS Proxy).
    // La usa Lectura y Configuración; si falta, lee de DATABASE_URL.
    DATABASE_READ_URL: optional(
      z.string().regex(/^postgres(ql)?:\/\/.+/, "debe empezar con postgresql:// o postgres://"),
    ),
    // ElastiCache (Redis). rediss:// cuando el cifrado en tránsito está activo.
    REDIS_URL: optional(
      z.string().regex(/^rediss?:\/\/.+/, "debe empezar con redis:// o rediss://"),
    ),
    // URL de la etapa de API Gateway WebSocket, para avisar a las pantallas.
    WEBSOCKET_ENDPOINT: optional(z.url()),
    // Cognito: valida el token al abrir el WebSocket. Si faltan, no se acepta
    // ninguna conexión (falla cerrado).
    COGNITO_USER_POOL_ID: optional(
      z
        .string()
        .regex(/^[\w-]+_[0-9A-Za-z]+$/, "formato esperado: us-east-2_AbCdEf123"),
    ),
    COGNITO_CLIENT_ID: optional(z.string().min(1)),
  })
  .refine(
    (env) =>
      Boolean(env.COGNITO_USER_POOL_ID) === Boolean(env.COGNITO_CLIENT_ID),
    {
      message: "COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID deben definirse juntas",
      path: ["COGNITO_CLIENT_ID"],
    },
  );

export type Env = z.infer<typeof envSchema>;

// Valida las variables de entorno. Recibe el origen como parámetro para poder
// probarlo sin tocar process.env. El error lista solo los nombres de las
// variables inválidas, nunca sus valores (DATABASE_URL lleva la contraseña).
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuración inválida:\n${problems}`);
  }

  return result.data;
}