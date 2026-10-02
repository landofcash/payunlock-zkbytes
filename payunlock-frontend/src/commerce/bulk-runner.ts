import { canonical } from "@/crypto/encoding";
import { ApiError, type Action, type OrderView, type Page, type PreparedTx } from "./client";
import { protocolOrder, reference, storageService, type ChainRecord } from "./lifecycle";
import { type BulkEntry, type BulkManifest, type BulkTransaction } from "./bulk-content";
import type { BulkDeliverySession } from "./delivery-session";
import type { PreparedDelivery } from "./protocol";
import { walletErrorKind } from "@/wallet/errors";

export type BulkApi = { request<T>(path: string, body?: unknown, method?: string): Promise<T>; read<T>(path: string): Promise<T> };
export type BulkRuntime = {
  api: BulkApi; journal: Pick<BulkDeliverySession, "entry" | "saveEntry" | "save">; current(): boolean;
  prepare(entry: BulkEntry, view: OrderView): Promise<PreparedDelivery>;
  send(tx: PreparedTx, action: Action, remember: (hash: string, raw?: string) => Promise<void>): Promise<void>;
  update(stage: string, entries: BulkEntry[], tx?: PreparedTx): void;
  sleep?(ms: number): Promise<void>;
};
export const splitError = (error: unknown) => error instanceof ApiError && ["ACTION_NOT_AVAILABLE", "BATCH_SIMULATION_FAILED", "BATCH_GAS_LIMIT"].includes(error.code);
export class NotSubmitted extends Error {}
export function actionIds(action: Action) { return "items" in action ? action.items.map(i => i.orderId) : "orderIds" in action ? action.orderIds : "orderId" in action ? [action.orderId] : []; }
async function snapshots(api: BulkApi, ids: string[]) {
  const result = new Map<string, OrderView>();
  for (let i = 0; i < ids.length; i += 30) {
    const page = await api.request<{ items: OrderView[] }>("/orders/batch", { orderIds: ids.slice(i, i + 30) });
    for (const view of page.items) result.set(view.orderId, view);
  }
  if (ids.some(id => !result.has(id))) throw new Error("Order status is incomplete. Retry without replacing the saved content.");
  return result;
}
export async function actionComplete(api: BulkApi, action: Action): Promise<boolean> {
  if (action.kind === "cancelProduct") return false; // Cancellation uses its finalized receipt/configuration.
  const views = await snapshots(api, actionIds(action));
  for (const id of actionIds(action)) {
    const view = views.get(id)!;
    if (action.kind === "reserveDeliveries" && BigInt(view.order.publicationDeadline) === 0n) return false;
    if (action.kind === "refundCanceledOrders" && view.order.state !== 9) return false;
    if (action.kind === "publishDeliveries") {
      const rows = await api.request<Page<ChainRecord>>(`/orders/${id}/records?after=-1&limit=1`);
      if (!rows.items.some(r => r.turn === "0" && canonical(r.reference) === canonical(action.items.find(i => i.orderId === id)!.reference))) return false;
    }
  }
  return actionIds(action).length > 0;
}
export async function settleTransaction(runtime: BulkRuntime, manifest: BulkManifest, pending: BulkTransaction) {
  const { api, journal } = runtime;
  const check = () => { if (!runtime.current()) throw new Error("Paused. Reconnect the same wallet to resume."); };
  for (let attempt = 0; attempt < 15; attempt++) {
    check();
    if (pending.hash) {
      const result = await api.request<{ status: string }>("/transactions/batch-status", { hash: pending.hash, action: pending.action });
      if (result.status === "uncertain" && pending.raw && attempt === 0) {
        // Identical signed bytes have one hash/nonce; retry transport, never create a replacement.
        check();
        try { await api.request("/transactions/broadcast", { action: pending.action, raw: pending.raw }); } catch { /* Remains uncertain; only authoritative effects or finality can settle it. */ }
      }
      if (result.status === "finalized_revert") { pending.status = "reverted"; await journal.save(manifest); return false; }
      if (result.status === "finalized_success") {
        if (pending.action.kind === "cancelProduct" ? (await api.request<{ configuration: { status: number } }>(`/seller/products/${manifest.productId}/registration`)).configuration.status !== 3 : !await actionComplete(api, pending.action)) throw new Error("Transaction finalized but its intended effects are not confirmed. Keep this operation and check again.");
        pending.status = "finalized"; await journal.save(manifest); return true;
      }
    } else {
      const canceled = pending.action.kind === "cancelProduct" && (await api.request<{ configuration: { status: number } }>(`/seller/products/${manifest.productId}/registration`)).configuration.status === 3;
      if (canceled || await actionComplete(api, pending.action)) { pending.status = "finalized"; await journal.save(manifest); return true; }
      throw new Error("Wallet result is uncertain. Check the existing transaction or provide its hash; do not send it again.");
    }
    if (attempt < 14) await (runtime.sleep?.(2000) ?? new Promise(resolve => setTimeout(resolve, 2000)));
  }
  throw new Error("Still waiting for finality. Resume to check this same transaction.");
}
export async function sendBatch(runtime: BulkRuntime, manifest: BulkManifest, action: Action, tx: PreparedTx) {
  if (!runtime.current()) throw new Error("Wallet changed.");
  const pending: BulkTransaction = { action, tx, status: "signing" };
  manifest.transactions.push(pending); await runtime.journal.save(manifest);
  try {
    if (!runtime.current()) throw new NotSubmitted("Wallet changed before signing.");
    await runtime.send(tx, action, async (hash, raw) => { pending.hash = hash; if (raw) pending.raw = raw; pending.status = "checking"; await runtime.journal.save(manifest); });
  } catch (error) {
    // Only explicit rejection proves an external wallet did not submit anything.
    if (!pending.hash && (error instanceof NotSubmitted || walletErrorKind(error) === "rejected")) pending.status = "rejected";
    else pending.status = "checking";
    await runtime.journal.save(manifest); throw error;
  }
  pending.status = "checking"; await runtime.journal.save(manifest);
  return settleTransaction(runtime, manifest, pending);
}
async function commitHash(runtime: BulkRuntime, manifest: BulkManifest, entry: BulkEntry) {
  if (entry.commitHash) return entry.commitHash;
  const saved = manifest.transactions.find(t => t.action.kind === "reserveDeliveries" && t.status === "finalized" && t.action.items.some(i => i.orderId === entry.order.orderId));
  if (saved?.hash) return saved.hash;
  let after: string | null = null;
  do {
    const page: Page<{ name: string; transactionHash: string }> = await runtime.api.request(`/orders/${entry.order.orderId}/history${after ? `?after=${after}` : ""}`);
    const row = page.items.find(row => row.name === "DeliveryReserved"); if (row) return row.transactionHash;
    after = page.nextCursor;
  } while (after);
  throw new Error("Reservation is finalized; its transaction hash is still syncing. Keep the saved delivery and retry.");
}
export async function runBulkDelivery(runtime: BulkRuntime, manifest: BulkManifest) {
  const { api, journal } = runtime;
  const check = () => { if (!runtime.current()) throw new Error("Paused. Unlock the same wallet and resume this operation."); };
  const active = await api.read<{ chainId: number; contract: string }>("/deployment");
  if (active.chainId !== manifest.deployment.chainId || active.contract.toLowerCase() !== manifest.deployment.contract) throw new Error("Operation belongs to another deployment.");
  const entries = await Promise.all(manifest.orderIds.map(id => journal.entry(manifest.id, id)));
  const update = (stage: string, tx?: PreparedTx) => { check(); runtime.update(stage, entries, tx); };
  for (const tx of manifest.transactions.filter(t => ["signing", "checking"].includes(t.status))) { update("Checking saved transaction"); await settleTransaction(runtime, manifest, tx); }
  const synchronize = async (entry: BulkEntry, cached?: OrderView) => {
    const before = canonical(entry);
    check(); const view = cached ?? await api.request<OrderView>(`/orders/${entry.order.orderId}`);
    if (canonical(protocolOrder(view, manifest.deployment)) !== canonical(entry.order) || view.order.productKey !== manifest.productKey || view.order.seller !== manifest.account) throw new Error("Purchased order identity changed.");
    if (entry.status === "published" && !entry.prepared) return view;
    if (entry.prepared && view.order.deliveryHash === entry.prepared.recordHash && view.order.state >= 3) {
      const records = await api.request<Page<ChainRecord>>(`/orders/${entry.order.orderId}/records?after=-1&limit=1`);
      if (!records.items.some(row => row.turn === "0" && canonical(row.reference) === canonical(reference(entry.prepared!.record)))) throw new Error("Publication history is syncing. Keep the saved delivery and resume to confirm it.");
      // Retain only public progress; discard plaintext, locator, ciphertext and wrapped content keys per order.
      const cleared: BulkEntry = { ...entry, status: "published", payload: { text: "", tickets: [] } };
      delete cleared.prepared;
      delete cleared.error;
      await journal.saveEntry(manifest.id, cleared);
      Object.assign(entry, cleared);
      delete entry.prepared;
      delete entry.error;
      return view;
    }
    else if (view.order.state === 2) {
      entry.deadline = view.order.publicationDeadline;
      if (view.canceled || BigInt(view.order.publicationDeadline) <= BigInt(view.block.timestamp)) { entry.status = "skipped"; entry.error = view.canceled ? "Offer canceled; refund available" : "Publication expired; refund available"; }
      else { entry.status = entry.prepared ? "committed" : "draft"; entry.commitHash = await commitHash(runtime, manifest, entry); }
    } else if (view.order.state !== 1 || view.canceled) { entry.status = "skipped"; entry.error = view.order.state === 9 ? "Refunded" : "No longer eligible; existing delivery retained"; }
    if (entry.prepared && [1, 2].includes(view.order.state) && !view.canceled && entry.status !== "skipped") {
      const publication = view.order.state === 2 ? Number(view.order.publicationDeadline) : Math.max(view.block.timestamp, Math.floor(Date.now() / 1000)) + Number(view.order.terms.commitmentWindow);
      const end = Math.max(publication, Number(view.order.terms.eventEnd)) + Number(view.order.terms.reviewWindow);
      if (end * 1000 >= Date.parse(entry.prepared.record.expiresAt)) { entry.status = "blocked"; entry.error = "Saved content no longer covers the purchased review window. Keep this record and use the order's refund path."; }
    }
    if (before !== canonical(entry)) await journal.saveEntry(manifest.id, entry); return view;
  };
  // Finish existing reservations before spending time on new preparations.
  const initial = await snapshots(api, manifest.orderIds);
  for (const entry of entries) await synchronize(entry, initial.get(entry.order.orderId));
  async function deliverBatch(group: BulkEntry[], publishing: boolean): Promise<void> {
    check();
    const fresh = await snapshots(api, group.map(e => e.order.orderId));
    for (const e of group) await synchronize(e, fresh.get(e.order.orderId));
    group = group.filter(e => e.status === (publishing ? "committed" : "uploaded"));
    if (!group.length) return;
    const { batchLimit } = await api.read<{ batchLimit: number }>("/platform");
    const limit = Math.min(30, Number(batchLimit)); if (limit < 1) throw new Error("Invalid batch configuration.");
    if (group.length > limit) { for (let i = 0; i < group.length; i += limit) await deliverBatch(group.slice(i, i + limit), publishing); return; }
    const action: Action = publishing ? { kind: "publishDeliveries", items: group.map(e => ({ orderId: e.order.orderId, reference: reference(e.prepared!.record), reservationTransaction: e.commitHash! })) } : { kind: "reserveDeliveries", items: group.map(e => ({ orderId: e.order.orderId })) };
    let tx: PreparedTx;
    try { tx = await api.request("/transactions/prepare", action); }
    catch (error) {
      if (!splitError(error)) throw error;
      if (group.length > 1) { const half = Math.ceil(group.length / 2); await deliverBatch(group.slice(0, half), publishing); await deliverBatch(group.slice(half), publishing); return; }
      const entry = group[0]!; await synchronize(entry);
      if (entry.status !== "skipped" && entry.status !== "published") { entry.status = "blocked"; entry.error = "This order could not be simulated. Check eligibility and retry."; await journal.saveEntry(manifest.id, entry); }
      return;
    }
    update(publishing ? "Approve publication" : "Approve reservation", tx);
    const success = await sendBatch(runtime, manifest, action, tx);
    update(publishing ? "Verifying publication" : "Reservation finalized");
    if (!success) {
      if (group.length > 1) { const half = Math.ceil(group.length / 2); await deliverBatch(group.slice(0, half), publishing); await deliverBatch(group.slice(half), publishing); }
      else { await synchronize(group[0]!); group[0]!.error = "Transaction reverted; refresh and retry this order."; if (group[0]!.status !== "skipped") group[0]!.status = "blocked"; await journal.saveEntry(manifest.id, group[0]!); }
      return;
    }
    const finalized = await snapshots(api, group.map(e => e.order.orderId));
    for (const e of group) await synchronize(e, finalized.get(e.order.orderId));
    if (!publishing) await deliverBatch(group, true);
  }
  await deliverBatch(entries.filter(e => e.status === "committed"), true);
  const { batchLimit } = await api.read<{ batchLimit: number }>("/platform");
  const size = Math.max(1, Math.min(30, Number(batchLimit)));
  for (let offset = 0; offset < entries.length; offset += size) {
    const group = entries.slice(offset, offset + size);
    const fresh = await snapshots(api, group.map(e => e.order.orderId));
    for (const entry of group) {
      const view = await synchronize(entry, fresh.get(entry.order.orderId)); if (["published", "skipped", "committed"].includes(entry.status) || entry.error?.startsWith("Saved content no longer")) continue;
      if (!entry.prepared) { update("Restore offer keys & encrypt"); entry.prepared = await runtime.prepare(entry, view); entry.status = "prepared"; await journal.saveEntry(manifest.id, entry); }
      check();
      if (entry.status !== "uploaded") {
        update("Save & upload encrypted content");
        const service = storageService(await api.read(`/storage-service?id=${entry.prepared.record.serviceId}`));
        const result = await service.client.recoverUpload(entry.prepared.item.seed, entry.prepared.record.creator);
        if (result.outcome === "active") { if (canonical(result.item) !== canonical(entry.prepared.item)) throw new Error("Uploaded content differs from the saved object."); }
        else if (result.outcome === "not-found") { check(); const uploaded = await service.client.upload(entry.prepared.item); if ("state" in uploaded) throw new Error("Upload is pending. Resume to check the same saved object."); }
        else throw new Error(`Storage ${result.outcome}. Keep the saved object; do not regenerate it.`);
        check(); entry.status = view.order.state === 2 ? "committed" : "uploaded"; delete entry.error; await journal.saveEntry(manifest.id, entry);
      }
    }
    await deliverBatch(group, false);
    await deliverBatch(group, true);
  }
  manifest.complete = entries.every(e => ["published", "skipped"].includes(e.status));
  await journal.save(manifest); update(manifest.complete ? "Delivery complete" : "Some orders need attention");
  return entries;
}

// Cancellation is a separate transaction. Refund batches never touch published orders.
export async function runBulkRefunds(runtime: BulkRuntime, manifest: BulkManifest, cancelOnly = false) {
  const { api, journal } = runtime;
  const entries = await Promise.all(manifest.orderIds.map(id => journal.entry(manifest.id, id)));
  const check = () => { if (!runtime.current()) throw new Error("Wallet changed. Resume the protected operation."); };
  for (const tx of manifest.transactions.filter(t => ["signing", "checking"].includes(t.status))) await settleTransaction(runtime, manifest, tx);
  const config = (await api.request<{ configuration: { status: number; productKey: string; contract: string; seller: string } }>(`/seller/products/${manifest.productId}/registration`)).configuration;
  if (config.productKey !== manifest.productKey || config.contract.toLowerCase() !== manifest.deployment.contract || config.seller.toLowerCase() !== manifest.account) throw new Error("Offer identity changed.");
  if (config.status !== 3) {
    if (!cancelOnly) throw new Error("Cancel the offer first.");
    const action: Action = { kind: "cancelProduct", productKey: manifest.productKey };
    const tx = await api.request<PreparedTx>("/transactions/prepare", action);
    runtime.update("Approve offer cancellation", entries, tx);
    if (!await sendBatch(runtime, manifest, action, tx)) throw new Error("Cancellation reverted. Refresh the offer before retrying.");
  }
  if (cancelOnly) { runtime.update("Offer canceled. Start refunds when ready.", entries); return entries; }
  async function refresh(entry: BulkEntry, cached?: OrderView) {
    check(); const before = canonical(entry), view = cached ?? await api.request<OrderView>(`/orders/${entry.order.orderId}`);
    if (canonical(protocolOrder(view, manifest.deployment)) !== canonical(entry.order) || view.order.productKey !== manifest.productKey) throw new Error("Order identity changed.");
    delete entry.error;
    if (view.order.state === 9) entry.status = "published"; // Terminal successful refund, including a concurrent buyer claim.
    else if (![1, 2].includes(view.order.state)) { entry.status = "skipped"; entry.error = "Published order: existing review, dispute and settlement rights preserved."; }
    else if (view.canceled) entry.status = "draft";
    else throw new Error("Cancellation is not finalized yet.");
    if (canonical(entry) !== before) await journal.saveEntry(manifest.id, entry);
  }
  async function batch(group: BulkEntry[]): Promise<void> {
    const fresh = await snapshots(api, group.map(e => e.order.orderId));
    for (const e of group) await refresh(e, fresh.get(e.order.orderId));
    group = group.filter(e => e.status === "draft"); if (!group.length) return;
    const { batchLimit } = await api.read<{ batchLimit: number }>("/platform"), limit = Math.min(30, Number(batchLimit));
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid batch configuration.");
    if (group.length > limit) { for (let i = 0; i < group.length; i += limit) await batch(group.slice(i, i + limit)); return; }
    const action: Action = { kind: "refundCanceledOrders", orderIds: group.map(e => e.order.orderId) };
    let failed: boolean;
    try {
      const tx = await api.request<PreparedTx>("/transactions/prepare", action);
      runtime.update("Approve refund batch", entries, tx);
      failed = !await sendBatch(runtime, manifest, action, tx);
    } catch (error) { if (!splitError(error) || manifest.transactions.some(t => ["signing", "checking"].includes(t.status))) throw error; failed = true; }
    if (failed) {
      if (group.length > 1) { const half = Math.ceil(group.length / 2); await batch(group.slice(0, half)); await batch(group.slice(half)); }
      else { const entry = group[0]!; await refresh(entry); if (entry.status === "draft") { entry.status = "blocked"; entry.error = "Refund failed for this recipient. Other refunds can continue; retry this order later."; await journal.saveEntry(manifest.id, entry); } }
    } else { const finalized = await snapshots(api, group.map(e => e.order.orderId)); for (const entry of group) await refresh(entry, finalized.get(entry.order.orderId)); }
  }
  await batch(entries);
  manifest.complete = entries.every(e => ["published", "skipped"].includes(e.status));
  await journal.save(manifest); runtime.update(manifest.complete ? "Refunds complete" : "Some refunds need attention", entries);
  return entries;
}
