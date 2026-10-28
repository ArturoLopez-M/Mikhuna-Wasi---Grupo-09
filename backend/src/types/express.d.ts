import type { AuthIdentity } from "./auth";

declare global {
  namespace Express {
    interface Request {
      identity?: AuthIdentity;
    }
  }
}

export {};