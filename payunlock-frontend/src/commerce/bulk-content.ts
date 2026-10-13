import {canonical, utf8} from "@/crypto/encoding";
import {type Opening, type Order, PayloadSchema, type PreparedDelivery} from "./protocol";
import type {Action, PreparedTx} from "./client";

export type ContentMode = "shared" | "rows" | "tickets";
export type BulkEntry = {
  order: Order;
  payload: Opening["payload"];
  prepared?: PreparedDelivery;
  status: "draft" | "prepared" | "uploaded" | "committed" | "published" | "skipped" | "blocked";
  commitHash?: string;
  deadline?: string;
  error?: string
};
export type BulkTransaction = {
  action: Action;
  tx: PreparedTx;
  hash?: string;
  raw?: string;
  status: "signing" | "checking" | "finalized" | "reverted" | "rejected"
};
export type BulkManifest = {
  version: 1;
  kind: "delivery" | "refund";
  id: string;
  account: string;
  deployment: Order["deployment"];
  productId: string;
  productKey: string;
  orderIds: string[];
  createdAt: string;
  mode: ContentMode;
  storageServiceId?: number;
  transactions: BulkTransaction[];
  complete: boolean
};

export function assignments(orders: Order[], shared: string, mode: ContentMode, rowsText: string, tickets: ReadonlyMap<string, string>): BulkEntry[] {
  if (!orders.length || new Set(orders.map(o => o.orderId)).size !== orders.length) throw new Error("Select distinct orders first.");
  const rows = rowsText.replace(/\r\n?/g, "\n").split("\n");
  if (mode === "rows" && (rows.length !== orders.length || rows.some(row => !row.trim()))) throw new Error(`Enter exactly ${orders.length} non-empty rows. Blank rows are not removed.`);
  return orders.map((order, i) => {
    const ticket = mode === "tickets" ? tickets.get(order.orderId) : undefined;
    if (mode === "tickets" && !ticket) throw new Error("Missing ticket assignment.");
    const payload = PayloadSchema.parse({
      text: mode === "rows" ? [shared, rows[i]].filter(Boolean).join("\n\n") : shared,
      tickets: ticket ? [{row: order.orderId, ticket}] : []
    });
    if (!payload.text.trim() && !payload.tickets.length) throw new Error("Add delivery content first.");
    // Include all protocol overhead in the same limit used by prepareDelivery.
    const opening = {
      version: 1,
      order,
      kind: "delivery",
      sender: order.seller.context.account,
      turn: "0",
      salt: `0x${"00".repeat(32)}`,
      payload
    };
    if (utf8(canonical(opening)).length > 65536) throw new Error(`Order #${order.orderId} exceeds the 64 KiB encrypted-content limit.`);
    return {order, payload, status: "draft"};
  });
}

export function deliveryText(entry: BulkEntry) {
  return [entry.payload.text, ...entry.payload.tickets.map(t => `Your ticket: ${t.ticket}`)].filter(Boolean).join("\n\n");
}
