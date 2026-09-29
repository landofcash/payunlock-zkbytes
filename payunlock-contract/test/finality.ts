import { expect } from "chai";
import { finalizedReceipt, type FinalityProvider, type Receipt } from "../scripts/finality.js";

describe("Canonical RPC finality", function () {
  const receipt: Receipt = { hash: "tx", blockNumber: 10, blockHash: "canonical", status: 1 };
  const provider = (changes: Partial<FinalityProvider> = {}): FinalityProvider => ({
    getTransactionReceipt: async () => receipt,
    getBlock: async tag => tag === "finalized" ? { number: 11, hash: "finalized" } : { number: 10, hash: "canonical" }, ...changes,
  });
  it("requires a finalized canonical receipt and retains confirmed reverts", async function () {
    expect(await finalizedReceipt(provider(), "tx")).to.deep.equal(receipt);
    expect((await finalizedReceipt(provider({ getTransactionReceipt: async () => ({ ...receipt, status: 0 }) }), "tx"))?.status).to.equal(0);
  });
  it("keeps missing, unfinalized, changed and reorged receipts uncertain", async function () {
    expect(await finalizedReceipt(provider({ getTransactionReceipt: async () => null }), "tx")).to.equal(null);
    expect(await finalizedReceipt(provider({ getBlock: async () => null }), "tx")).to.equal(null);
    expect(await finalizedReceipt(provider({ getBlock: async () => ({ number: 9, hash: "canonical" }) }), "tx")).to.equal(null);
    expect(await finalizedReceipt(provider({ getBlock: async tag => ({ number: 11, hash: tag === "finalized" ? "finalized" : "reorg" }) }), "tx")).to.equal(null);
    let calls = 0;
    expect(await finalizedReceipt(provider({ getTransactionReceipt: async () => ++calls === 1 ? receipt : null }), "tx")).to.equal(null);
  });
});
