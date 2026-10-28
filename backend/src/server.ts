import "dotenv/config";
import { createApp } from "./app";
import { loadEnv, type Env } from "./config/env";
import { createDatabase } from "./db/pool";

let env: Env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const db = createDatabase(env.DATABASE_URL);
const app = createApp({ db });

app.listen(env.PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${env.PORT}`);
});