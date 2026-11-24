import type { AuthIdentity, Role } from "../../src/types/auth";

// Simula un usuario ya autenticado con el rol indicado, sin Cognito ni base.
export function asRole(
  role: Role,
  restaurantId = "11111111-1111-4111-8111-111111111111",
): AuthIdentity {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    restaurantId,
    role,
  };
}
