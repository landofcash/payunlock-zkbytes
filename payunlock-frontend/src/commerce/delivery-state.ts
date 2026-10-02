import { commitment } from "@/crypto/encoding";
import type { PreparedDelivery } from "./protocol";

export type Progress = "prepared" | "upload-uncertain" | "uploaded" | "tx1-pending" | "tx1-finalized" | "tx2-pending" | "published";
export type Pending = PreparedDelivery & { version: 1; progress: Progress; tx1: string | null; tx2: string | null };
export function pendingId(prepared: PreparedDelivery) {
  return commitment("payunlock-pending-v1", { deployment: prepared.record.order.deployment, orderId: prepared.record.order.orderId, kind: prepared.record.kind, turn: prepared.record.turn, sender: prepared.record.sender });
}
