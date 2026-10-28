// Catálogo de códigos de error del contrato (Docs/api-contract.md, sección 3).
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_ORDER_STATUS"
  | "ORDER_ALREADY_PAID"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "PRODUCT_UNAVAILABLE"
  | "PRODUCT_LIMIT_REACHED"
  | "INTERNAL_ERROR";

export interface ErrorDetail {
  field: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}