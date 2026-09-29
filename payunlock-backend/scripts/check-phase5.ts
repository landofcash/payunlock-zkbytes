import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, hexlify, randomBytes, parseEther } from "ethers";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ChainService, escrowAddress } from "../src/services/chain-service.js";
import type { Action } from "../src/services/transaction-service.js";
// Explicit opt-in: this acceptance check spends test MON, never mainnet funds.
if (!process.argv.includes("--send-test-transactions")) throw new Error("Pass --send-test-transactions to run the Monad Testnet acceptance check.");
const config = loadConfig(), provider = new JsonRpcProvider(config.MONAD_TESTNET_RPC_URL);
if ((await provider.getNetwork()).chainId !== 10143n) throw new Error("Monad Testnet required");
const funder = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY!, provider);
const root = new URL("../../output/phase-5/", import.meta.url);
await mkdir(root, { recursive: true });
const actorFile = new URL("actors.json", root);
let actors: { seller: string; buyer: string };
try { actors = JSON.parse(await readFile(actorFile, "utf8")); }
catch { actors = { seller: Wallet.createRandom().privateKey, buyer: Wallet.createRandom().privateKey }; await writeFile(actorFile, JSON.stringify(actors), { flag: "wx" }); }
const seller = new Wallet(actors.seller, provider), buyer = new Wallet(actors.buyer, provider);
const manifest = JSON.parse(await readFile(new URL("../../payunlock-contract/deployments/monad-testnet-payunlock-v4.json", import.meta.url), "utf8"));
const app = buildApp({ ...config, LOG_LEVEL: "silent" }), chain = new ChainService(config.MONAD_TESTNET_RPC_URL);
const origin = "http://127.0.0.1:4320";
let evidence: Record<string, unknown> = { chainId: 10143, contract: escrowAddress, at: new Date().toISOString(), transactions: [] };
try { evidence = JSON.parse(await readFile(new URL("acceptance.json", root), "utf8")); } catch { /* First run. */ }
const tokens = new Map<string, string>();
async function api<T = Record<string, unknown>>(wallet: Wallet | null, path: string, body?: unknown, method?: "GET" | "POST" | "PUT"): Promise<T> {
  const result = await app.inject({ method: method ?? (body === undefined ? "GET" : "POST"), url: `/v1${path}`, headers: { origin, "content-type": "application/json", ...(wallet ? { authorization: `Bearer ${tokens.get(wallet.address)}` } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  if (result.statusCode !== 200) throw new Error(`${path}: ${result.statusCode} ${result.json().error}`);
  return result.json() as T;
}
async function login(wallet: Wallet) {
  const challenge = await api<{ id: string; message: string }>(null, "/auth/challenge", { address: wallet.address });
  const result = await api<{ token: string }>(null, "/auth/verify", { id: challenge.id, signature: await wallet.signMessage(challenge.message) });
  tokens.set(wallet.address, result.token);
}
async function finalized(hash: string, wallet: Wallet, target = escrowAddress) {
  for (let i = 0; i < 60; i++) {
    const result = await chain.transaction(hash, wallet.address.toLowerCase(), target);
    if (result.status === "finalized_revert") throw new Error("Test transaction reverted");
    if (result.status === "finalized_success") return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Finality pending; recover before retrying.");
}
async function send(wallet: Wallet, action: Action) {
  const tx = await api<{ to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string }>(wallet, "/transactions/prepare", action);
  const raw = await wallet.signTransaction({ chainId: 10143, type: 2, to: tx.to, data: tx.data, value: BigInt(tx.value), nonce: tx.nonce, gasLimit: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
  const result = await api<{ hash: string }>(wallet, "/transactions/broadcast", { action, raw });
  (evidence.transactions as unknown[]).push({ kind: action.kind, hash: result.hash });
  await writeFile(new URL("acceptance.json", root), JSON.stringify(evidence, null, 2));
  await finalized(result.hash, wallet, tx.to.toLowerCase());
}
try {
  await app.ready();
  if (evidence.status === "passed") { console.info("Existing Phase 5 acceptance already passed; no new transactions sent."); await app.close(); provider.destroy(); process.exit(0); }
  if (process.argv.includes("--rebalance") && !evidence.rebalanced) {
    const tx = await seller.sendTransaction({ to: buyer.address, value: parseEther("0.035") }); await tx.wait();
    evidence.rebalanced = true; await writeFile(new URL("acceptance.json", root), JSON.stringify(evidence, null, 2));
  }
  for (const [wallet, minimum] of (process.argv.includes("--skip-funding") ? [] : [[seller, parseEther("0.18")], [buyer, parseEther("0.22")]]) as [Wallet, bigint][]) {
    const balance = await provider.getBalance(wallet.address);
    if (balance < minimum) { const tx = await funder.sendTransaction({ to: wallet.address, value: minimum - balance, nonce: await provider.getTransactionCount(funder.address, "pending") }); await tx.wait(); }
  }
  const token = new Contract(manifest.testToken, ["function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], funder);
  if (await token.getFunction("balanceOf")(buyer.address) < 1000000n) await (await token.getFunction("transfer")(buyer.address, 1000000n, { nonce: await provider.getTransactionCount(funder.address, "pending") })).wait();
  await login(seller); await login(buyer);
  const orderIds: string[] = [];
  for (const [name, paymentToken, price] of [["Native", ZeroAddress, "1000000000000"], ["Token", manifest.testToken.toLowerCase(), "1000"]]) {
    const draft = { title: `Phase 5 ${name} acceptance`, description: "Test-only acceptance offer", visibility: "hidden", draftTerms: { token: paymentToken, price, eventEnd: null, reviewWindow: "0", commitmentWindow: 60 } };
    let saved: { productId: string; requestId: string; receiving: { nonce: string; publicKey: string } } | undefined;
    try { saved = JSON.parse(await readFile(new URL(`request-${name}.json`, root), "utf8")); } catch { /* First run. */ }
    const product = saved ? { id: saved.productId } : await api<{ id: string }>(seller, "/seller/products", draft);
    const key = hexlify(randomBytes(32)), receiving = saved?.receiving ?? { nonce: hexlify(randomBytes(32)), publicKey: hexlify(randomBytes(32)) };
    if (!saved) {
      await api(seller, `/seller/products/${product.id}/registration`, { productKey: key }, "PUT");
      await send(seller, { kind: "create", productId: product.id, receiving });
    }
    const registered = await api<{ configuration: { terms: { reviewWindow: string } } }>(seller, `/seller/products/${product.id}/registration`);
    assert.equal(registered.configuration.terms.reviewWindow, "0");
    const requestId = saved?.requestId ?? hexlify(randomBytes(32));
    await writeFile(new URL(`request-${name}.json`, root), JSON.stringify({ productId: product.id, requestId, receiving, buyer: buyer.address, seller: seller.address }));
    const checkout = await api<{ configuration: { expectedTerms: string } }>(buyer, `/products/${product.id}/checkout`, { requestId, buyerReceiving: receiving });
    let recovered = await api<{ status: string; orderId: string; order: { state: number } }>(buyer, `/orders/recover/${requestId}`);
    if (recovered.status !== "finalized") {
      if (paymentToken !== ZeroAddress) await send(buyer, { kind: "approve", requestId, expectedTerms: checkout.configuration.expectedTerms });
      await send(buyer, { kind: "purchase", requestId, expectedTerms: checkout.configuration.expectedTerms });
      recovered = await api(buyer, `/orders/recover/${requestId}`);
    }
    assert.equal(recovered.status, "finalized"); assert.ok([1, 9].includes(recovered.order.state)); orderIds.push(recovered.orderId);
    const retry = await app.inject({ method: "POST", url: "/v1/transactions/prepare", headers: { origin, authorization: `Bearer ${tokens.get(buyer.address)}` }, payload: { kind: "purchase", requestId, expectedTerms: checkout.configuration.expectedTerms } });
    assert.equal(retry.json().error, "PURCHASE_ALREADY_FINALIZED");
    if (recovered.order.state === 1) await send(buyer, { kind: "claimRefund", orderId: recovered.orderId });
    const refunded = await api<{ order: { state: number } }>(buyer, `/orders/${recovered.orderId}`); assert.equal(refunded.order.state, 9);
    const controlled = evidence[`${name}Controls`] === true;
    if (controlled) continue;
    await send(seller, { kind: "disable", productId: product.id, disabled: true });
    const blocked = await app.inject({ method: "POST", url: `/v1/products/${product.id}/checkout`, headers: { origin, authorization: `Bearer ${tokens.get(buyer.address)}` }, payload: { requestId: hexlify(randomBytes(32)), buyerReceiving: receiving } });
    assert.equal(blocked.json().error, "SALES_UNAVAILABLE");
    await send(seller, { kind: "disable", productId: product.id, disabled: false });
    evidence[`${name}Controls`] = true;
    await writeFile(new URL("acceptance.json", root), JSON.stringify(evidence, null, 2));
    console.info(`${name}: registered, purchased, recovered, refunded, disabled and re-enabled.`);
  }
  assert.notEqual(orderIds[0], orderIds[1]); evidence.orderIds = orderIds; evidence.status = "passed";
  await writeFile(new URL("acceptance.json", root), JSON.stringify(evidence, null, 2));
  console.info("Phase 5 Monad Testnet acceptance passed.");
} catch (error) { console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[redacted endpoint]") : "Acceptance failed"); process.exitCode = 1; }
finally { await app.close(); provider.destroy(); }
