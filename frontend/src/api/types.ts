// Tipos del contrato (Docs/api-contract.md).
export type Role = "admin" | "waiter" | "kitchen" | "cashier" | "delivery";
export type ServiceMode = "dine_in" | "delivery" | "both";
export type OrderStatus = "pending" | "preparing" | "ready" | "closed" | "cancelled";
export type DeliveryStatus = "pending_dispatch" | "on_the_way" | "delivered" | "failed";

export interface Me {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  restaurant: { id: string; name: string; serviceMode: ServiceMode };
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  notes: string | null;
}

export interface Order {
  id: string;
  serviceType: "dine_in" | "delivery";
  tableLabel: string | null;
  delivery: {
    address: string;
    status: DeliveryStatus;
    assignedTo: { id: string; fullName: string } | null;
  } | null;
  status: OrderStatus;
  notes: string | null;
  createdBy: { id: string; fullName: string };
  createdAt: string;
  items: OrderItem[];
  total: string;
  payment: { amount: string; method: string; createdAt: string } | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string;
  isAvailable: boolean;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { field: string; message: string }[] };
}
