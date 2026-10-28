import type { RequestHandler } from "express";
import type { Role } from "../../src/types/auth";

// Simula un usuario autenticado con el rol indicado, sin Cognito.
export function asRole(
  role: Role,
  restaurantId = "11111111-1111-4111-8111-111111111111",
): RequestHandler {
  return (req, _res, next) => {
    req.identity = {
      userId: "22222222-2222-4222-8222-222222222222",
      restaurantId,
      role,
    };
    next();
  };
}