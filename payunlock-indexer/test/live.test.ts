import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
describe.skipIf(process.env.PAYUNLOCK_LIVE_INDEXER_TEST !== "1")("v4 reservation live backfill", () => {
  it("rebuilds a reservation, publication and settlement deterministically", async () => {
    const run = async () => {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 10143: { startBlock: 66208796, endBlock: 66209781 } } });
      return { orders: await indexer.ChainOrder.getAll(), events: await indexer.ChainEvent.getAll(), records: await indexer.ChainRecord.getAll() };
    };
    const first = await run(); expect(await run()).toEqual(first);
    expect(first.orders).toHaveLength(1);
    expect(first.orders[0]).toMatchObject({ state: 8, orderId: 1n });
    expect(first.events.some(e => e.name === "DeliveryReserved")).toBe(true);
    expect(first.events.some(e => e.name === "RecordPublished")).toBe(true);
    expect(first.records).toHaveLength(1);
  }, 120000);
});
