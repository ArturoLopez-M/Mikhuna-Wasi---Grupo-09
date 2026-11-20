import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env";

const validUrl =
  "postgresql://postgres:clave_de_prueba@localhost:5432/mikhuna";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("loadEnv", () => {
  it("aplica los valores por defecto", () => {
    const env = loadEnv({ DATABASE_URL: validUrl });

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe(validUrl);
  });

  it("convierte PORT a número", () => {
    const env = loadEnv({ DATABASE_URL: validUrl, PORT: "4000" });

    expect(env.PORT).toBe(4000);
  });

  it("falla si falta DATABASE_URL", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("falla si PORT no es un puerto válido", () => {
    expect(() => loadEnv({ DATABASE_URL: validUrl, PORT: "abc" })).toThrow(
      /PORT/,
    );
  });

  it("falla si NODE_ENV tiene un valor desconocido", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: validUrl, NODE_ENV: "staging" }),
    ).toThrow(/NODE_ENV/);
  });

  it("no revela el valor de DATABASE_URL en el mensaje de error", () => {
    const message = messageOf(() =>
      loadEnv({ DATABASE_URL: "mysql://usuario:clave_de_prueba@host/db" }),
    );

    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("clave_de_prueba");
  });
});

describe("loadEnv: Cognito", () => {
  const pool = "us-east-2_AbCdEf123";

  it("es opcional: sin variables de Cognito la configuración es válida", () => {
    const env = loadEnv({ DATABASE_URL: validUrl });

    expect(env.COGNITO_USER_POOL_ID).toBeUndefined();
    expect(env.COGNITO_CLIENT_ID).toBeUndefined();
  });

  it("acepta las dos variables juntas", () => {
    const env = loadEnv({
      DATABASE_URL: validUrl,
      COGNITO_USER_POOL_ID: pool,
      COGNITO_CLIENT_ID: "abc123",
    });

    expect(env.COGNITO_USER_POOL_ID).toBe(pool);
    expect(env.COGNITO_CLIENT_ID).toBe("abc123");
  });

  it("falla si solo se define una de las dos", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: validUrl, COGNITO_USER_POOL_ID: pool }),
    ).toThrow(/COGNITO_CLIENT_ID/);
    expect(() =>
      loadEnv({ DATABASE_URL: validUrl, COGNITO_CLIENT_ID: "abc123" }),
    ).toThrow(/COGNITO_CLIENT_ID/);
  });

  it("falla si el User Pool ID no tiene el formato esperado", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: validUrl,
        COGNITO_USER_POOL_ID: "no-es-un-pool",
        COGNITO_CLIENT_ID: "abc123",
      }),
    ).toThrow(/COGNITO_USER_POOL_ID/);
  });

  it("una variable vacía cuenta como no definida", () => {
    const env = loadEnv({
      DATABASE_URL: validUrl,
      COGNITO_USER_POOL_ID: "",
      COGNITO_CLIENT_ID: "",
    });

    expect(env.COGNITO_USER_POOL_ID).toBeUndefined();
  });
});
