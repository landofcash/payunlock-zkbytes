// Manual Vite/browser acceptance probe. Reuses only the saved PUBLIC synthetic
// Node fixture; never pass a real wallet or real pending operation to this module.
import { Wallet } from "ethers";
import { ZkbytesClient, ZkbytesError, ZkbytesApiError } from "@zkbytes/sdk";
import { FulfillmentJournal } from "../src/commerce/journal";
import { IndexedStore } from "../src/storage/local-store";
import { openDelivery, restoreReceiving } from "../src/commerce/protocol";

export async function checkStorageBrowser(backup: string) {
  let stage = "import";
  try {
    const password = "payunlock-public-test-fixture-only";
    const journal = new FulfillmentJournal(new IndexedStore("payunlock-public-cors-fixture-v1"));
    const { id } = JSON.parse(backup) as { id: string };
    // Idempotent reruns preserve the encrypted fixture in this isolated browser DB.
    const store = new IndexedStore("payunlock-public-cors-fixture-v1");
    if (!await store.get(`pending:${id}`)) await journal.import(backup, password);
    const pending = await journal.restore(id, password);
    const client = new ZkbytesClient({ apiOrigin: "https://api.zkbytes.com", downloadOrigin: "https://zkbytes.b-cdn.net" });
    stage = "upload";
    // Same signed object, same seed: exercise POST/preflight without a new object.
    await client.upload(pending.item);
    stage = "recover";
    const outcome = await journal.recoverUpload(id, password, client, () => true);
    if (outcome !== "active") throw new Error("Fixture not active");
    for (const role of ["buyer", "seller"] as const) {
      stage = `${role}-restore-open`;
      const wallet = new Wallet("0x" + "0".repeat(63) + (role === "buyer" ? "1" : "2"));
      const identity = await restoreReceiving(pending.record.order[role].context, wallet, () => true, pending.record.order[role].publicKey);
      try {
        const opened = await openDelivery({ record: pending.record, expectedRecordHash: pending.recordHash, order: pending.record.order, role, privateKey: identity.privateKey, services: [{ id: 1, client, maxRetentionSeconds: 0 }], isCurrent: () => true });
        if (opened.payload.text !== pending.opening.payload.text) throw new Error("Payload mismatch");
      } finally { identity.privateKey.fill(0); }
    }
    return { ok: true, checkedAt: new Date().toISOString(), origin: location.origin, outcome, recordHash: pending.recordHash, expiresAt: pending.record.expiresAt, buyerRestoreOpen: true, sellerRestoreOpen: true, blockchainTransactionSubmitted: false };
  } catch (error) {
    return { ok: false, stage, errorType: error instanceof Error ? error.name : "unknown", code: error instanceof ZkbytesError ? error.code : undefined, httpStatus: error instanceof ZkbytesApiError ? error.status : undefined };
  }
}
