import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Order } from "../src/domain.js";
import { CatalogRepository } from "../src/repositories/catalog-repository.js";
import { deployment, escrowAddress } from "../src/services/chain-service.js";

it("associates the reviewed revision using the accepted V5 commitment, even after a later review", async () => {
  const accepted = `0x${"11".repeat(32)}`, latest = `0x${"22".repeat(32)}`;
  const receiving = { nonce: accepted, publicKey: latest };
  const order = { buyer: "buyer", requestId: "request", buyerReceiving: receiving } as Order;
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("SELECT * FROM checkout_intents")) return { rows: [{ id: "intent", revision: 3, expected_terms: latest, buyer_receiving: receiving }] };
    if (sql.startsWith("SELECT revision,configuration")) return { rows: params[1] === accepted ? [{ revision: 2 }] : [] };
    return { rows: [] };
  });
  const catalog = new CatalogRepository({ query } as unknown as Pool);
  await catalog.associate("7", order, async () => accepted);
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO purchased_offers"), [deployment.chainId, escrowAddress, "7", "intent", 2]);
  query.mockClear();
  await catalog.associate("7", order, async () => null);
  expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO purchased_offers"))).toBe(false);
  query.mockClear();
  const lookup = vi.fn(async () => accepted);
  await catalog.associate("7", { ...order, buyerReceiving: { ...receiving, nonce: latest } }, lookup);
  expect(lookup).not.toHaveBeenCalled();
});
