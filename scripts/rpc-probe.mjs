export async function probeRpc(url, { alchemyOnly = false, fetcher = fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error("Invalid RPC URL configuration."); }
  if (alchemyOnly && (endpoint.protocol !== "https:" || endpoint.hostname !== "monad-testnet.g.alchemy.com" || !/^\/v2\/[^/]+$/.test(endpoint.pathname))) throw new Error("Configure a provisioned Alchemy Monad Testnet endpoint in MONAD_TESTNET_RPC_URL.");
  const observations = [];
  async function rpc(method, params = []) {
    let response;
    try { response = await fetcher(endpoint.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`RPC ${method}: network error or timeout; result uncertain.`); }
    observations.push({ method, httpStatus: response.status });
    if (response.status === 429) throw new Error(`RPC ${method}: rate limited (429); retry later with backoff.`);
    if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}.`);
    let body;
    try { body = await response.json(); } catch { throw new Error(`RPC ${method}: invalid JSON response.`); }
    if (body?.jsonrpc !== "2.0" || body.id !== 1 || body.error || !("result" in body)) throw new Error(`RPC ${method}: rejected or malformed JSON-RPC response.`);
    return body.result;
  }
  const chain = await rpc("eth_chainId");
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 10143n) throw new Error("RPC is not Monad Testnet (10143).");
  const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
  if (!block || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !/^0x[0-9a-f]+$/i.test(block.number)) throw new Error("No valid finalized block returned.");
  return { provider: alchemyOnly ? "alchemy" : "configured-rpc", chainId: 10143, block: block.number, blockHash: block.hash, observations };
}
