import "dotenv/config";
import { app } from "./app";
import { loadEnv, type Env } from "./config/env";

let env: Env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

app.listen(env.PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${env.PORT}`);
});