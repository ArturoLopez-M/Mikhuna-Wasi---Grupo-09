import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .regex(
      /^postgres(ql)?:\/\/.+/,
      "debe empezar con postgresql:// o postgres://",
    ),
});

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