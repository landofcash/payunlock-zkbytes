/* global Response */
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeRpc } from "./rpc-probe.mjs";
const endpoint = "https://monad-testnet.g.alchemy.com/v2/test-placeholder";
test("checks chain and finality without exposing the endpoint", async () => {
  const result = await probeRpc(endpoint, { alchemyOnly: true, fetcher: async (_, init) => {
    const call = JSON.parse(init.body);
    return Response.json({ jsonrpc: "2.0", id: 1, result: call.method === "eth_chainId" ? "0x279f" : { hash: "0x" + "a".repeat(64), number: "0x1" } });
  } });
  assert.equal(result.chainId, 10143); assert.equal(result.observations.length, 2);
  assert.ok(!JSON.stringify(result).includes("test-placeholder"));
});
test("rejects wrong providers, rate limits, RPC errors, null finality and network failures", async () => {
  await assert.rejects(probeRpc("https://testnet-rpc.monad.xyz", { alchemyOnly: true }), /Configure/);
  for (const [response, message] of [[new Response("", { status: 429 }), /rate limited/], [Response.json({ jsonrpc: "2.0", id: 1, error: { message: endpoint } }), /malformed/], [Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }), /not Monad/]]) await assert.rejects(probeRpc(endpoint, { fetcher: async () => response }), message);
  await assert.rejects(probeRpc(endpoint, { fetcher: async () => { throw new Error(endpoint); } }), error => !error.message.includes("test-placeholder"));
  let count = 0;
  await assert.rejects(probeRpc(endpoint, { fetcher: async () => Response.json({ jsonrpc: "2.0", id: 1, result: count++ ? null : "0x279f" }) }), /finalized/);
});
