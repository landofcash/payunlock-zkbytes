import { z } from "zod";
import { validateStorageItem, type ZkbytesClient } from "@zkbytes/sdk";
import { canonical, commitment, strictJson } from "@/crypto/encoding";
import { decryptWithPassword, encryptWithPassword } from "@/crypto/password-envelope";
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
// A separate user passphrase unlocks recovery for both built-in and external wallets.
// Neither wallet-dependent signatures nor the enclosed object seed are needed to unlock it.
export class FulfillmentJournal {
  constructor(private readonly store: LocalStore) {}
  async prepare(prepared: PreparedDelivery, password: string, isCurrent: () => boolean) {
    const pending = validate({ version: 1, ...prepared, progress: "prepared", tx1: null, tx2: null });
    const id = pendingId(pending), storageKey = `pending:${id}`;
    const envelope = await encryptWithPassword(canonical(pending), password, { domain: "payunlock-pending-v1", id });
    if (!isCurrent()) throw new Error("Session changed.");
    await this.store.compareAndSwap(storageKey, undefined, envelope);
    return id;
  }
  async restore(id: string, password: string) {
    const envelope = await this.store.get(`pending:${id}`);
    const pending = validate(strictJson(await decryptWithPassword(envelope, password, { domain: "payunlock-pending-v1", id })));
    if (pendingId(pending) !== id) throw new Error("Wrong recovery identity.");
    return pending;
  }
  async update(id: string, password: string, next: Progress, txHash: string | null = null) {
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
    await this.store.compareAndSwap(storageKey, before, envelope);
  }
  async upload(id: string, password: string, client: ZkbytesClient, isCurrent: () => boolean) {
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
  async recoverUpload(id: string, password: string, client: ZkbytesClient, isCurrent: () => boolean) {
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
  async import(text: string, password: string) {
    const backup = z.strictObject({ version: z.literal(1), id: z.string(), envelope: z.unknown() }).parse(strictJson(text));
    const pending = validate(strictJson(await decryptWithPassword(backup.envelope, password, { domain: "payunlock-pending-v1", id: backup.id })));
    if (pendingId(pending) !== backup.id) throw new Error("Wrong recovery identity.");
    await this.store.compareAndSwap(`pending:${backup.id}`, undefined, backup.envelope);
    return backup.id;
  }
  async cleanup(id: string, password: string) {
    const pending = await this.restore(id, password);
    if (pending.progress !== "published") throw new Error("Keep unpublished recovery material.");
    await this.store.remove(`pending:${id}`);
  }
}
