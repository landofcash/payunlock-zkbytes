import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedStore } from "../storage/local-store";
import { PurchaseJournal, purchaseMatches, type Operation } from "../commerce/purchase-journal";
const account = `0x${"11".repeat(20)}`, contract = `0x${"22".repeat(20)}`, id = `0x${"33".repeat(32)}`;
function operation(): Operation { return { id, requestId: id, account, deployment: { chainId: 10143, contract }, context: { version: 1, account, deployment: { chainId: 10143, contract }, nonce: id }, receiving: { nonce: id, publicKey: id }, progress: "draft", hashes: [], version: 0 }; }
describe("durable purchase identity", () => {
  it("retains the same identity after a lost hash response and reload and isolates accounts", async () => {
    const name = crypto.randomUUID(), store = new IndexedStore(name), journal = new PurchaseJournal(store);
    const initial = await journal.save(operation());
    await journal.save({ ...initial, progress: "checking" });
    const reloaded = new PurchaseJournal(new IndexedStore(name));
    expect(await reloaded.list(account)).toMatchObject([{ requestId: id, progress: "checking", hashes: [], context: initial.context }]);
    expect(await reloaded.list(contract)).toEqual([]);
  });
  it("rejects stale competing tab writes and replacing the original identity", async () => {
    const journal = new PurchaseJournal(new IndexedStore(crypto.randomUUID()));
    const initial = await journal.save(operation());
    const outcomes = await Promise.allSettled([journal.save({ ...initial, progress: "checking" }), journal.save({ ...initial, progress: "review" })]);
    expect(outcomes.filter(v => v.status === "fulfilled")).toHaveLength(1);
    const latest = (await journal.list(account))[0]!;
    await expect(journal.save({ ...latest, requestId: `0x${"44".repeat(32)}` })).rejects.toThrow("identity");
  });
  it("keeps intentional repeat purchases separate and verifies recovered receiving keys", async () => {
    const journal = new PurchaseJournal(new IndexedStore(crypto.randomUUID()));
    await journal.save(operation());
    await journal.save({ ...operation(), id: "separate", requestId: `0x${"44".repeat(32)}` });
    expect(await journal.list(account)).toHaveLength(2);
    expect(purchaseMatches(operation(), { buyer: account, requestId: id, buyerReceiving: operation().receiving! })).toBe(true);
    expect(purchaseMatches(operation(), { buyer: account, requestId: id, buyerReceiving: { nonce: id, publicKey: "different" } })).toBe(false);
  });
  it("removes only a current unsent checkout and preserves pending payment recovery", async () => {
    const journal = new PurchaseJournal(new IndexedStore(crypto.randomUUID()));
    const removable = await journal.save(operation());
    const pending = await journal.save({ ...operation(), id: "pending", requestId: `0x${"44".repeat(32)}`, progress: "checking" });
    await journal.remove(removable);
    expect((await journal.list(account)).map(row => row.id)).toEqual(["pending"]);
    await expect(journal.remove(pending)).rejects.toThrow("Check the payment status");
    const reverted = await journal.save({ ...pending, progress: "reverted" });
    await expect(journal.remove(pending)).rejects.toThrow("another tab");
    await journal.remove(reverted);
    expect(await journal.list(account)).toEqual([]);
  });
});
