import { z } from "zod";
import { Transaction } from "ethers";
import { canonical, utf8, strictJson } from "@/crypto/encoding";
import { encryptDraft as encryptWithPassword, decryptDraft as decryptWithPassword, type DraftCredential } from "@/crypto/draft-envelope";
import type { LocalStore } from "@/storage/local-store";
import { OrderSchema, PayloadSchema, OpeningSchema, RecordSchema, contentHash, recordHash, type Order, type Opening, type PreparedDelivery } from "./protocol";
import { validateStorageItem } from "@zkbytes/sdk";
import type { Action, PreparedTx } from "./client";

export type ContentMode = "shared" | "rows" | "tickets";
export type BulkEntry = { revision?: number; order: Order; payload: Opening["payload"]; prepared?: PreparedDelivery; status: "draft" | "prepared" | "uploaded" | "committed" | "published" | "skipped" | "blocked"; commitHash?: string; deadline?: string; error?: string };
export type BulkTransaction = { action: Action; tx: PreparedTx; hash?: string; raw?: string; status: "signing" | "checking" | "finalized" | "reverted" | "rejected" };
export type BulkManifest = { revision?: number; version: 1; kind: "delivery" | "refund"; id: string; account: string; deployment: Order["deployment"]; productId: string; productKey: string; orderIds: string[]; createdAt: string; mode: ContentMode; storageServiceId?: number; transactions: BulkTransaction[]; complete: boolean };
export type BulkIndex = Pick<BulkManifest, "id" | "productId" | "createdAt" | "complete"> & Partial<Pick<BulkManifest, "kind" | "orderIds">>;
const address = z.string().regex(/^0x[0-9a-f]{40}$/), hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/), uint = z.string().regex(/^(0|[1-9][0-9]*)$/), orderId = z.string().regex(/^[1-9][0-9]*$/);
const ref = z.strictObject({ serviceId: z.number().int().positive().max(4294967295), preparedAt: uint, creator: hash, buyerEnvelope: z.string().regex(/^0x03[0-9a-fA-F]{128}$/), sellerEnvelope: z.string().regex(/^0x03[0-9a-fA-F]{128}$/), contentHash: hash });
const batchAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancelProduct"), productKey: hash }),
  z.strictObject({ kind: z.literal("reserveDeliveries"), items: z.array(z.strictObject({ orderId })).min(1).max(30) }),
  z.strictObject({ kind: z.literal("publishDeliveries"), items: z.array(z.strictObject({ orderId, reference: ref, reservationTransaction: hash })).min(1).max(30) }),
  z.strictObject({ kind: z.literal("refundCanceledOrders"), orderIds: z.array(orderId).min(1).max(30) }),
]);
const savedTx = z.strictObject({ chainId: z.literal(10143), to: address, data: z.string().regex(/^0x[0-9a-fA-F]+$/), value: z.literal("0"), gas: uint, nonce: z.number().int().nonnegative(), maxFeePerGas: uint, maxPriorityFeePerGas: uint, balance: uint });
const meta = z.object({ revision: z.number().int().nonnegative().optional(), version: z.literal(1), kind: z.enum(["delivery", "refund"]), id: z.uuid(), account: address, deployment: z.object({ chainId: z.literal(10143), contract: address }), productId: z.uuid(), productKey: hash, orderIds: z.array(orderId), createdAt: z.string(), mode: z.enum(["shared", "rows", "tickets"]), storageServiceId: z.number().int().positive().max(4294967295).optional(), transactions: z.array(z.strictObject({ action: batchAction, tx: savedTx, hash: hash.optional(), raw: z.string().regex(/^0x[0-9a-fA-F]+$/).max(200000).optional(), status: z.enum(["signing", "checking", "finalized", "reverted", "rejected"]) })), complete: z.boolean() });
export function assignments(orders: Order[], shared: string, mode: ContentMode, rowsText: string, tickets: ReadonlyMap<string, string>): BulkEntry[] {
  if (!orders.length || new Set(orders.map(o => o.orderId)).size !== orders.length) throw new Error("Select distinct orders first.");
  const rows = rowsText.replace(/\r\n?/g, "\n").split("\n");
  if (mode === "rows" && (rows.length !== orders.length || rows.some(row => !row.trim()))) throw new Error(`Enter exactly ${orders.length} non-empty rows. Blank rows are not removed.`);
  return orders.map((order, i) => {
    const ticket = mode === "tickets" ? tickets.get(order.orderId) : undefined;
    if (mode === "tickets" && !ticket) throw new Error("Missing ticket assignment.");
    const payload = PayloadSchema.parse({ text: mode === "rows" ? [shared, rows[i]].filter(Boolean).join("\n\n") : shared, tickets: ticket ? [{ row: order.orderId, ticket }] : [] });
    if (!payload.text.trim() && !payload.tickets.length) throw new Error("Add delivery content first.");
    // Include all protocol overhead in the same limit used by prepareDelivery.
    const opening = { version: 1, order, kind: "delivery", sender: order.seller.context.account, turn: "0", salt: `0x${"00".repeat(32)}`, payload };
    if (utf8(canonical(opening)).length > 65536) throw new Error(`Order #${order.orderId} exceeds the 64 KiB encrypted-content limit.`);
    return { order, payload, status: "draft" };
  });
}
export function deliveryText(entry: BulkEntry) { return [entry.payload.text, ...entry.payload.tickets.map(t => `Your ticket: ${t.ticket}`)].filter(Boolean).join("\n\n"); }
export class BulkJournal {
  constructor(private store: LocalStore) {}
  private index(account: string, deployment: Order["deployment"]) { return `bulk-index-v1:${deployment.chainId}:${deployment.contract}:${account}`; }
  async list(account: string, deployment: Order["deployment"]): Promise<BulkIndex[]> { return (await this.store.get(this.index(account, deployment)) ?? []) as BulkIndex[]; }
  async create(manifest: BulkManifest, entries: BulkEntry[], password: DraftCredential, current: () => boolean) {
    const previous = await this.list(manifest.account, manifest.deployment);
    if (manifest.kind === "delivery" && previous.some(p => !p.complete && p.kind === "delivery" && p.orderIds?.some(id => manifest.orderIds.includes(id)))) throw new Error("A selected order belongs to a saved delivery. Resume that operation first.");
    for (const entry of entries) { if (!current()) throw new Error("Wallet changed."); await this.write(`bulk-entry:${manifest.id}:${entry.order.orderId}`, entry, password, undefined); }
    if (!current()) throw new Error("Wallet changed.");
    await this.write(`bulk:${manifest.id}`, manifest, password, undefined);
    const key = this.index(manifest.account, manifest.deployment), before = await this.store.get(key);
    await this.store.compareAndSwap(key, before, [...(before as BulkIndex[] ?? []), { id: manifest.id, productId: manifest.productId, createdAt: manifest.createdAt, complete: false, kind: manifest.kind, orderIds: manifest.orderIds }]);
  }
  private async write(key: string, value: unknown, password: DraftCredential, before: unknown) {
    const encrypted = await encryptWithPassword(canonical(value), password, { domain: "payunlock-bulk-v1", id: key });
    if (encrypted.ciphertext.length > 8_000_000) throw new Error("Recovery data is too large to persist. No transaction was sent.");
    await this.store.compareAndSwap(key, before, encrypted);
  }
  async load(id: string, password: DraftCredential): Promise<BulkManifest> {
    const key = `bulk:${id}`, result = meta.parse(strictJson(await decryptWithPassword(await this.store.get(key), password, { domain: "payunlock-bulk-v1", id: key }))) as BulkManifest;
    if (result.id !== id || new Set(result.orderIds).size !== result.orderIds.length || result.transactions.some(t => t.tx.to !== result.deployment.contract || (t.action.kind === "cancelProduct" ? t.action.productKey !== result.productKey || result.kind !== "refund" : ("items" in t.action ? t.action.items.map(i => i.orderId) : "orderIds" in t.action ? t.action.orderIds : []).some(id => !result.orderIds.includes(id))))) throw new Error("Invalid saved operation.");
    for (const pending of result.transactions) if (pending.raw) {
      const tx = Transaction.from(pending.raw);
      if (tx.hash !== pending.hash || tx.from?.toLowerCase() !== result.account || tx.to?.toLowerCase() !== result.deployment.contract || tx.chainId !== 10143n || tx.data !== pending.tx.data || tx.value !== 0n || tx.nonce !== pending.tx.nonce) throw new Error("Saved signed transaction mismatch.");
    }
    return result;
  }
  async entry(id: string, orderId: string, password: DraftCredential): Promise<BulkEntry> {
    const key = `bulk-entry:${id}:${orderId}`, entry = strictJson(await decryptWithPassword(await this.store.get(key), password, { domain: "payunlock-bulk-v1", id: key })) as BulkEntry;
    OrderSchema.parse(entry.order); PayloadSchema.parse(entry.payload);
    z.enum(["draft", "prepared", "uploaded", "committed", "published", "skipped", "blocked"]).parse(entry.status);
    if (entry.order.orderId !== orderId) throw new Error("Order assignment mismatch.");
    if (entry.prepared) {
      const p = entry.prepared; RecordSchema.parse(p.record); OpeningSchema.parse(p.opening); validateStorageItem(p.item);
      if (canonical(p.opening.order) !== canonical(entry.order) || canonical(p.opening.payload) !== canonical(entry.payload) || p.recordHash !== recordHash(p.record) || contentHash(p.opening) !== p.record.contentHash || canonical(p.item.creator) !== canonical(p.record.creator) || canonical(p.record.order) !== canonical(entry.order)) throw new Error("Saved delivery integrity mismatch.");
    }
    return entry;
  }
  async save(manifest: BulkManifest, password: DraftCredential) {
    const key = `bulk:${manifest.id}`, before = await this.store.get(key);
    const previous = await this.load(manifest.id, password);
    if ((previous.revision ?? 0) !== (manifest.revision ?? 0)) throw new Error("Operation changed in another tab. Reload it.");
    const revision = (manifest.revision ?? 0) + 1;
    await this.write(key, { ...manifest, revision }, password, before);
    manifest.revision = revision;
    const index = this.index(manifest.account, manifest.deployment), rows = await this.store.get(index);
    await this.store.compareAndSwap(index, rows, (rows as BulkIndex[]).map(r => r.id === manifest.id ? { ...r, complete: manifest.complete } : r));
  }
  async saveEntry(id: string, entry: BulkEntry, password: DraftCredential) {
    const key = `bulk-entry:${id}:${entry.order.orderId}`, before = await this.store.get(key), old = await this.entry(id, entry.order.orderId, password);
    if ((old.revision ?? 0) !== (entry.revision ?? 0)) throw new Error("Order changed in another tab. Reload it.");
    const revision = (entry.revision ?? 0) + 1;
    await this.write(key, { ...entry, revision }, password, before); entry.revision = revision;
  }
  async export(id: string, password: DraftCredential) {
    const manifest = await this.load(id, password), keys = [`bulk:${id}`, ...manifest.orderIds.map(order => `bulk-entry:${id}:${order}`)];
    return JSON.stringify({ version: 1, id, records: await Promise.all(keys.map(async key => [key, await this.store.get(key)])) });
  }
  async import(text: string, password: DraftCredential, account: string, deployment: Order["deployment"]) {
    const backup = z.object({ version: z.literal(1), id: z.uuid(), records: z.array(z.tuple([z.string(), z.unknown()])) }).parse(strictJson(text));
    const map = new Map(backup.records), key = `bulk:${backup.id}`;
    const manifest = meta.parse(strictJson(await decryptWithPassword(map.get(key), password, { domain: "payunlock-bulk-v1", id: key }))) as BulkManifest;
    if (manifest.id !== backup.id || manifest.account !== account || canonical(manifest.deployment) !== canonical(deployment)) throw new Error("Backup belongs to another account or deployment.");
    const keys = [key, ...manifest.orderIds.map(id => `bulk-entry:${backup.id}:${id}`)];
    for (const key of keys) { if (!map.has(key)) throw new Error("Incomplete recovery backup."); if (await this.store.get(key)) throw new Error("Operation already exists. Resume its current local state."); }
    // Validate every authenticated record before any writes.
    const temporary = new BulkJournal({ ...this.store, get: async key => map.get(key) } as LocalStore);
    await temporary.load(manifest.id, password);
    for (const orderId of manifest.orderIds) await temporary.entry(manifest.id, orderId, password);
    for (const key of keys) await this.store.compareAndSwap(key, undefined, map.get(key));
    const index = this.index(account, deployment), rows = await this.store.get(index);
    await this.store.compareAndSwap(index, rows, [...(rows as BulkIndex[] ?? []), { id: manifest.id, productId: manifest.productId, createdAt: manifest.createdAt, complete: manifest.complete, kind: manifest.kind, orderIds: manifest.orderIds }]);
    return manifest;
  }
}
