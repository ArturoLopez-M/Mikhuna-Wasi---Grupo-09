import { Router, type RequestHandler } from "express";
import type { Database } from "../db/pool";

export interface ApiDependencies {
  db: Database;
  authenticate: RequestHandler;
}

// Router de /api/v1. Todo lo que cuelga de aquí exige autenticación.
//
// Convención: cada módulo de negocio vive en src/modules/<nombre>/ con su
// router, servicio y repositorio, y se registra aquí. Por ejemplo:
//   router.use("/products", createProductsRouter(deps));
export function createApiRouter(deps: ApiDependencies): Router {
  const router = Router();

  router.use(deps.authenticate);

  return router;
}