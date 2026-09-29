// Deterministic test-only JSON-RPC source. Never signs or broadcasts transactions.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Interface, keccak256, toUtf8Bytes, ZeroAddress, ZeroHash, toQuantity } from "ethers";
const abi = JSON.parse(readFileSync(new URL("../abi/PayUnlock.json", import.meta.url), "utf8"));
const iface = new Interface(abi.abi);
const address = "0xe69c6d3783e4ed59b7900f1766e325ed65ddd364";
const buyer = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const arbA = "0x3333333333333333333333333333333333333333";
const arbB = "0x4444444444444444444444444444444444444444";
const start = 65572889;
const h = (s: string) => keccak256(toUtf8Bytes(s));
let branch = "A";
const hash = (n: number) => h(`${n}:${n < start + 3 ? "common" : branch}`);
const block = (n: number) => ({ number: toQuantity(n), hash: hash(n), parentHash: hash(n - 1), timestamp: toQuantity(1700000000 + n - start),
  nonce: "0x0000000000000000", sha3Uncles: ZeroHash, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: ZeroHash, stateRoot: ZeroHash, receiptsRoot: ZeroHash,
  miner: ZeroAddress, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x100", gasLimit: "0x1c9c380", gasUsed: "0x10000", baseFeePerGas: "0x1", transactions: [], uncles: [] });
function logs() {
  const receiving = { nonce: h("nonce"), publicKey: h("key") };
  const terms = { token: ZeroAddress, price: 1000n, hasEventEnd: false, eventEnd: 0, reviewWindow: 86400, responseWindow: 259200, commitmentWindow: 600 };
  const order = { state: 1, buyer, seller, productKey: h("product"), requestId: h("request"), buyerReceiving: receiving, sellerReceiving: receiving,
    terms, deliveryHash: ZeroHash, publicationDeadline: 0, reviewDeadline: 0, responseDeadline: 0, turn: 0 };
  const values: [number, string, unknown[]][] = [
    [start + 1, "Purchased", [1, buyer, h("request"), order]],
    [start + 2, "DeliveryReserved", [1, h("delivery"), 1700000600]],
    [start + 3, "ArbitrationAssigned", [1, { wallet: branch === "A" ? arbA : arbB, publicKey: h(branch), keyVersion: 1, revision: 1, fee: 5, requester: buyer, handoverRecorded: false }, ZeroHash]],
  ];
  return values.map(([n, name, args]) => ({ ...iface.encodeEventLog(iface.getEvent(name)!, args), address, blockNumber: toQuantity(n), blockHash: hash(n), transactionHash: h(`tx:${hash(n)}`), transactionIndex: "0x0", logIndex: "0x0", removed: false }));
}
const server = createServer(async (req, res) => {
  if (req.url === "/fork" && req.method === "POST") { branch = "B"; res.end("forked"); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const execute = (r: { id: number; method: string; params: unknown[] }) => {
    const head = start + (branch === "A" ? 10 : 11);
    const height = (value: unknown) => typeof value === "string" && value.startsWith("0x") ? Number(BigInt(value)) : head;
    let result: unknown;
    switch (r.method) {
      case "eth_chainId": result = toQuantity(10143); break;
      case "eth_blockNumber": result = toQuantity(head); break;
      case "eth_getBlockByNumber": result = block(height(r.params[0])); break;
      case "eth_getLogs": {
        const filter = r.params[0] as { fromBlock?: string; toBlock?: string; topics?: (string | string[] | null)[] };
        result = logs().filter(l => height(l.blockNumber) >= height(filter.fromBlock) && height(l.blockNumber) <= height(filter.toBlock) && (!filter.topics?.[0] || (Array.isArray(filter.topics[0]) ? filter.topics[0].includes(l.topics[0]!) : l.topics[0] === filter.topics[0])));
        break;
      }
      default: return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Unsupported fixture RPC method" } };
    }
    return { jsonrpc: "2.0", id: r.id, result };
  };
  try { const parsed = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(execute) : execute(parsed))); }
  catch { res.statusCode = 400; res.end("Invalid fixture request"); }
});
server.listen(18546, "0.0.0.0", () => console.info("Controlled reorg fixture listening on port 18546"));
