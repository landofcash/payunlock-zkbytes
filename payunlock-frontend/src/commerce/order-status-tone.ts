export type OrderStatusTone = "waiting" | "attention" | "completed" | "refunded" | "neutral";

export function orderStatusTone(state: number, attention = false): OrderStatusTone {
  if (attention) return "attention";
  if (state === 9) return "refunded";
  if (state === 8) return "completed";
  return state >= 1 && state <= 7 ? "waiting" : "neutral";
}
