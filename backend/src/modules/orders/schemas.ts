import { z } from "zod";

const orderItemSchema = z.strictObject({
  productId: z.uuid(),
  quantity: z.int().min(1).max(99),
  notes: z.string().trim().max(200).nullable().optional(),
});

export const createOrderSchema = z.strictObject({
  tableLabel: z.string().trim().min(1).max(30),
  notes: z.string().trim().max(500).nullable().optional(),
  items: z.array(orderItemSchema).min(1).max(50),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;