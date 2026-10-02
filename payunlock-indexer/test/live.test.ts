import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { readFileSync } from "node:fs";
describe.skipIf(process.env.PAYUNLOCK_LIVE_INDEXER_TEST !== "1")("V5 purchase live backfill", () => {
  it("rebuilds V5 purchases deterministically", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../../payunlock-contract/deployments/monad-testnet-payunlock-v5.json", import.meta.url), "utf8"));
    const endBlock = Number(process.env.PAYUNLOCK_LIVE_INDEXER_END_BLOCK);
    if (!Number.isSafeInteger(endBlock) || endBlock <= manifest.deploymentBlock) throw new Error("Set PAYUNLOCK_LIVE_INDEXER_END_BLOCK to a finalized V5 block containing purchases.");
    const run = async () => {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 10143: { startBlock: manifest.deploymentBlock, endBlock } } });
      return { orders: await indexer.ChainOrder.getAll(), events: await indexer.ChainEvent.getAll(), records: await indexer.ChainRecord.getAll() };
    };
    const first = await run(); expect(await run()).toEqual(first);
    expect(first.orders.length).toBeGreaterThan(0);
    expect(first.events.some(e => e.name === "Purchased")).toBe(true);
  }, 120000);
});
