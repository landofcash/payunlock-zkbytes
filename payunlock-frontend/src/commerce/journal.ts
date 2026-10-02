import { z } from "zod";
import { validateStorageItem, type ZkbytesClient } from "@zkbytes/sdk";
import { canonical, commitment, strictJson } from "@/crypto/encoding";
import { encryptDraft as encryptWithPassword, decryptDraft as decryptWithPassword, isOfferDraft, type DraftCredential } from "@/crypto/draft-envelope";
import type { LocalStore } from "@/storage/local-store";
import { contentHash, OpeningSchema, RecordSchema, recordHash, type PreparedDelivery } from "./protocol";

const ProgressSchema = z.enum(["prepared", "upload-uncertain", "uploaded", "tx1-pending", "tx1-finalized", "tx2-pending", "published"]);
export type Progress = z.infer<typeof ProgressSchema>;
const PendingSchema = z.strictObject({ version: z.literal(1), record: RecordSchema, recordHash: z.string(), item: z.unknown().transform(x => validateStorageItem(x)), opening: OpeningSchema, progress: ProgressSchema, tx1: z.string().nullable(), tx2: z.string().nullable() });
export type Pending = z.infer<typeof PendingSchema>;
export function pendingId(prepared: PreparedDelivery) {
  return commitment("payunlock-pending-v1", { deployment: prepared.record.order.deployment, orderId: prepared.record.order.orderId, kind: prepared.record.kind, turn: prepared.record.turn, sender: prepared.record.sender });
}
function validate(value: unknown): Pending {
  const record = PendingSchema.parse(value);
  if (recordHash(record.record) !== record.recordHash || contentHash(record.opening) !== record.record.contentHash || canonical(record.record.order) !== canonical(record.opening.order) || canonical(record.item.creator) !== canonical(record.record.creator) || record.item.expiresAt !== record.record.expiresAt || record.item.managers.length) throw new Error("Recovery record integrity check failed.");
  return record;
}
// Encrypt recovery drafts with the supplied credential and verify their commitments.
export class FulfillmentJournal {
  constructor(private readonly store: LocalStore) {}
  async prepare(prepared: PreparedDelivery, password: DraftCredential, isCurrent: () => boolean) {
    const pending = validate({ version: 1, ...prepared, progress: "prepared", tx1: null, tx2: null });
    const id = pendingId(pending), storageKey = `pending:${id}`;
    const envelope = await encryptWithPassword(canonical(pending), password, { domain: "payunlock-pending-v1", id });
    if (!isCurrent()) throw new Error("Session changed.");
    await this.store.compareAndSwap(storageKey, undefined, { ...envelope, ...(typeof password !== "string" ? { recordHash: pending.recordHash } : {}) });
    return id;
  }
  async restore(id: string, password: DraftCredential) {
    const envelope = await this.store.get(`pending:${id}`);
    const pending = validate(strictJson(await decryptWithPassword(envelope, password, { domain: "payunlock-pending-v1", id })));
    if (pendingId(pending) !== id) throw new Error("Wrong recovery identity.");
    return pending;
  }
  async update(id: string, password: DraftCredential, next: Progress, txHash: string | null = null) {
    const storageKey = `pending:${id}`, before = await this.store.get(storageKey);
    const pending = validate(strictJson(await decryptWithPassword(before, password, { domain: "payunlock-pending-v1", id })));
    const transitions: Record<Progress, Progress[]> = {
      prepared: ["upload-uncertain"], "upload-uncertain": ["upload-uncertain", "uploaded"], uploaded: ["tx1-pending"],
      "tx1-pending": ["tx1-pending", "tx1-finalized"], "tx1-finalized": ["tx2-pending"], "tx2-pending": ["tx2-pending", "published"], published: [],
    };
    if (!transitions[pending.progress].includes(next)) throw new Error("Invalid recovery transition.");
    if (txHash !== null && !/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error("Invalid transaction hash.");
    pending.progress = next;
    if (next === "tx1-pending" && txHash) pending.tx1 = txHash;
    if (next === "tx2-pending" && txHash) pending.tx2 = txHash;
    const envelope = await encryptWithPassword(canonical(pending), password, { domain: "payunlock-pending-v1", id });
    await this.store.compareAndSwap(storageKey, before, { ...envelope, ...(typeof password !== "string" ? { recordHash: pending.recordHash } : {}) });
  }
  async upload(id: string, password: DraftCredential, client: ZkbytesClient, isCurrent: () => boolean) {
    const pending = await this.restore(id, password);
    if (!isCurrent()) throw new Error("Session changed.");
    if (!["prepared", "upload-uncertain"].includes(pending.progress)) throw new Error("Recover the existing operation instead.");
    // Commit the uncertain state BEFORE the network request. A lost response keeps all original material.
    await this.update(id, password, "upload-uncertain");
    if (!isCurrent()) throw new Error("Session changed.");
    try {
      const result = await client.upload(pending.item);
      if (!isCurrent()) throw new Error("Session changed.");
      if (!("state" in result)) await this.update(id, password, "uploaded");
      return result;
    } catch (cause) { throw new Error("Upload outcome uncertain. Recover the original object before proceeding.", { cause }); }
  }
  async recoverUpload(id: string, password: DraftCredential, client: ZkbytesClient, isCurrent: () => boolean) {
    const pending = await this.restore(id, password);
    if (!isCurrent()) throw new Error("Session changed.");
    const result = await client.recoverUpload(pending.item.seed, pending.record.creator);
    if (!isCurrent()) throw new Error("Session changed.");
    if (result.outcome === "active") {
      if (canonical(result.item) !== canonical(pending.item)) throw new Error("Recovered object differs from prepared object.");
      if (pending.progress === "upload-uncertain") await this.update(id, password, "uploaded");
    }
    return result.outcome;
  }
  async export(id: string) { const value = await this.store.get(`pending:${id}`); if (!value) throw new Error("Recovery record missing."); return canonical({ version: 1, id, envelope: value }); }
  async import(text: string, password: DraftCredential) {
    const backup = z.strictObject({ version: z.literal(1), id: z.string(), envelope: z.unknown() }).parse(strictJson(text));
    const pending = validate(strictJson(await decryptWithPassword(backup.envelope, password, { domain: "payunlock-pending-v1", id: backup.id })));
    if (pendingId(pending) !== backup.id) throw new Error("Wrong recovery identity.");
    if (isOfferDraft(backup.envelope) && (backup.envelope as { recordHash?: string }).recordHash !== pending.recordHash) throw new Error("Recovery commitment mismatch.");
    await this.store.compareAndSwap(`pending:${backup.id}`, undefined, backup.envelope);
    return backup.id;
  }
  async cleanup(id: string, password: DraftCredential) {
    const pending = await this.restore(id, password);
    if (pending.progress !== "published") throw new Error("Keep unpublished recovery material.");
    await this.store.remove(`pending:${id}`);
  }
  // Caller supplies the exact commitment from a finalized published record, never TX1 or an order state alone.
  async cleanupConfirmed(id: string, publishedHash: string, credential?: DraftCredential) {
    const key = `pending:${id}`, before = await this.store.get(key);
    if (!before) return true;
    const hash = isOfferDraft(before) ? (before as { recordHash?: string }).recordHash : credential !== undefined ? (await this.restore(id, credential)).recordHash : undefined;
    if (!hash || hash !== publishedHash) return false;
    await this.store.compareAndSwap(key, before, undefined);
    return true;
  }
}
