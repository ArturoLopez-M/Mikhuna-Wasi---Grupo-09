import "dotenv/config";
import type { RequestHandler } from "express";
import { createApp } from "./app";
import { createCognitoVerifier } from "./auth/cognito";
import { loadEnv, type Env } from "./config/env";
import { createDatabase } from "./db/pool";
import { createAuthenticate } from "./middleware/authenticate";

let env: Env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const db = createDatabase(env.DATABASE_URL);
// Sin configuración de Cognito se usa el middleware por defecto, que rechaza
// todo con 401: es mejor no dejar entrar a nadie que dejar entrar a cualquiera.
let authenticate: RequestHandler | undefined;
if (env.COGNITO_USER_POOL_ID && env.COGNITO_CLIENT_ID) {
  authenticate = createAuthenticate({
    db,
    verifyToken: createCognitoVerifier({
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
    }),
  });
} else {
  console.warn(
    "Cognito no está configurado: la API rechazará todas las peticiones (401).",
  );
}

const app = createApp({ db, authenticate });

app.listen(env.PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${env.PORT}`);
});