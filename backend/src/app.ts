import express from "express";
import type { Database } from "./db/pool";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export interface AppDependencies {
  db: Database;
}

export function createApp({ db }: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.status(200).json({ status: "ok" });
    } catch (err) {
      // El motivo va solo al log; la respuesta no filtra información interna.
      console.error(
        "Health check: base de datos no disponible:",
        err instanceof Error ? err.message : err,
      );
      res.status(503).json({ status: "error" });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}