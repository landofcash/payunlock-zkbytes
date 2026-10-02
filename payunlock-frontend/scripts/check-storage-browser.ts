// Manual Vite/browser acceptance probe. Reuses only the saved PUBLIC synthetic
// Node fixture; never pass a real wallet or real pending operation to this module.
import { Wallet } from "ethers";
import { ZkbytesClient, ZkbytesError, ZkbytesApiError } from "@zkbytes/sdk";
import { DeliverySession } from "../src/commerce/delivery-session";
import { decryptWithPassword } from "../src/crypto/password-envelope";
import { openDelivery, restoreReceiving, type PreparedDelivery } from "../src/commerce/protocol";

export async function checkStorageBrowser(backup: string) {
  let stage = "import";
  try {
    const password = "payunlock-public-test-fixture-only";
    const session = new DeliverySession();
    const prepared = JSON.parse(await decryptWithPassword(JSON.parse(backup), password, { domain: "payunlock-storage-probe-v1" })) as PreparedDelivery;
    const id = await session.prepare(prepared, () => true);
    const pending = await session.restore(id);
    const client = new ZkbytesClient({ apiOrigin: "https://api.zkbytes.com", downloadOrigin: "https://zkbytes.b-cdn.net" });
    stage = "upload";
    // Same signed object, same seed: exercise POST/preflight without a new object.
    await client.upload(pending.item);
    stage = "recover";
    const outcome = await session.recoverUpload(id, client, () => true);
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
