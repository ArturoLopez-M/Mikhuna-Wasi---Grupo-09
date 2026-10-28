// Roles del sistema (Docs/api-contract.md, sección 4).
export const ROLES = ["admin", "waiter", "kitchen", "cashier"] as const;
export type Role = (typeof ROLES)[number];

// Identidad del usuario autenticado. La rellena el middleware de autenticación
// a partir del token de Cognito y de la fila del usuario en la base. El
// restaurantId y el rol NUNCA vienen del cliente.
export interface AuthIdentity {
  userId: string;
  restaurantId: string;
  role: Role;
}