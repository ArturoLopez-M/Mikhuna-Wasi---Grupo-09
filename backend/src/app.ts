import express, { type RequestHandler } from "express";
import type { Database } from "./db/pool";
import { authenticatePlaceholder } from "./middleware/authPlaceholder";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { createApiRouter } from "./routes";

export interface AppDependencies {
  db: Database;
  // Por defecto rechaza todo (401). La rama de Cognito inyecta la real.
  authenticate?: RequestHandler;
}

export function createApp({
  db,
  authenticate = authenticatePlaceholder,
}: AppDependencies) {
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

  app.use("/api/v1", createApiRouter({ db, authenticate }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}