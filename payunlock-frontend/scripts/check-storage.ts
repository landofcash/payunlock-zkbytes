// Explicit integration probe. Creates one synthetic encrypted, undeletable one-year object.
// No wallet is funded and no blockchain transaction is sent.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Wallet } from "ethers";
import { ZkbytesClient, ZkbytesError, ZkbytesApiError } from "@zkbytes/sdk";
import { prepareDelivery, restoreReceiving, newReceivingContext, openDelivery, RETENTION_SECONDS, type Order } from "../src/commerce/protocol";
import { FulfillmentJournal } from "../src/commerce/journal";
import type { LocalStore } from "../src/storage/local-store";

const directory = resolve("../output/phase-2-live/resumable-fixture-v1");
// Public test material ONLY. Never use this probe store for personal data or funded wallets.
const password = "payunlock-public-test-fixture-only";
let stage = "configuration";
// Single-process probe store only. Production uses transactional IndexedDB.
class ProbeStore implements LocalStore {
  private path(key: string) { if (!/^pending:0x[0-9a-f]{64}$/.test(key)) throw new Error("Invalid probe key"); return join(directory, key.replace(":", "-") + ".json"); }
  async get(key: string) { try { return JSON.parse(await readFile(this.path(key), "utf8")) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async put(key: string, value: unknown) { const path = this.path(key); await writeFile(path + ".tmp", JSON.stringify(value)); await rename(path + ".tmp", path); }
  async remove() { throw new Error("Probe retains its encrypted recovery evidence."); }
  async compareAndSwap(key: string, expected: unknown, value: unknown) { if (JSON.stringify(await this.get(key)) !== JSON.stringify(expected)) throw new Error("Probe record changed."); await this.put(key, value); }
}

async function main() {
  const apiOrigin = process.env.ZKBYTES_SERVICE_URL, downloadOrigin = process.env.ZKBYTES_DOWNLOAD_ORIGIN;
  const cap = Number(process.env.ZKBYTES_MAX_RETENTION_SECONDS);
  if (!apiOrigin || !downloadOrigin || !Number.isSafeInteger(cap) || (cap !== 0 && cap < RETENTION_SECONDS)) throw new Error("Configure API/download origins and a compatible retention cap.");
  const client = new ZkbytesClient({ apiOrigin, downloadOrigin });
  stage = "receiving-identities";
  const service = { id: "zkbytes-live-v1", client, maxRetentionSeconds: cap };
  const buyerWallet = new Wallet("0x" + "0".repeat(63) + "1"), sellerWallet = new Wallet("0x" + "0".repeat(63) + "2");
  const deployment = { chainId: 10143 as const, contract: "0x" + "1".repeat(40) };
  const buyer = await restoreReceiving(newReceivingContext(deployment, buyerWallet.address), buyerWallet, () => true);
  const seller = await restoreReceiving(newReceivingContext(deployment, sellerWallet.address), sellerWallet, () => true);
  try {
    const order: Order = { deployment, orderId: "1", buyer: { context: buyer.context, publicKey: buyer.publicKey }, seller: { context: seller.context, publicKey: seller.publicKey }, terms: { version: 1, token: "0x" + "0".repeat(40), price: "0", eventEnd: null, reviewWindow: "60", responseWindow: "259200" } };
    await mkdir(directory, { recursive: true });
    const journal = new FulfillmentJournal(new ProbeStore());
    stage = "load-journal";
    let id: string;
    try { id = await readFile(join(directory, "id.txt"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const prepared = await prepareDelivery({ order, payload: { text: "PayUnlock Phase 2 synthetic integration fixture. No purchased content or personal data.", tickets: [] }, signer: sellerWallet, service, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 600), isCurrent: () => true });
      id = await journal.prepare(prepared, password, () => true);
      await writeFile(join(directory, "id.txt"), id);
    }
    const restored = await new FulfillmentJournal(new ProbeStore()).restore(id, password);
    stage = "recover-upload";
    let outcome = await journal.recoverUpload(id, password, client, () => true);
    if (outcome === "not-found") {
      stage = "upload";
      try { await journal.upload(id, password, client, () => true); }
      catch (error) {
        const cause = (error as Error).cause;
        if (cause instanceof ZkbytesError) console.error(JSON.stringify({ code: cause.code, httpStatus: cause instanceof ZkbytesApiError ? cause.status : undefined }));
      }
      outcome = await journal.recoverUpload(id, password, client, () => true);
    }
    console.log(JSON.stringify({ recoveryOutcome: outcome }));
    if (outcome !== "active") throw new Error(`Storage is ${outcome}; retry recovery of the existing probe, not a new upload.`);
    for (const role of ["buyer", "seller"] as const) {
      stage = `${role}-restore-open`;
      const identity = await restoreReceiving(restored.record.order[role].context, role === "buyer" ? buyerWallet : sellerWallet, () => true, restored.record.order[role].publicKey);
      try {
        const opened = await openDelivery({ record: restored.record, expectedRecordHash: restored.recordHash, order: restored.record.order, role, privateKey: identity.privateKey, services: [service], isCurrent: () => true });
        if (opened.payload.text !== restored.opening.payload.text) throw new Error("Opened fixture mismatch.");
      } finally { identity.privateKey.fill(0); }
    }
    const result = { checkedAt: new Date().toISOString(), outcome, recordHash: restored.recordHash, contentHash: restored.record.contentHash, expiresAt: restored.record.expiresAt, buyerRestoreOpen: true, sellerRestoreOpen: true, managers: 0, syntheticContract: true, blockchainTransactionSubmitted: false };
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { buyer.privateKey.fill(0); seller.privateKey.fill(0); }
}
main().catch(error => { console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown" })); if (error instanceof ZkbytesError) console.error(JSON.stringify({ code: error.code, httpStatus: error instanceof ZkbytesApiError ? error.status : undefined })); console.error("Storage probe did not complete. Check endpoint/CORS/retention configuration. This command resumes the saved synthetic fixture on rerun. No secret values logged."); process.exitCode = 1; });
