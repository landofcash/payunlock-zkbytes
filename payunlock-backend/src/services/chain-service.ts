import { readFileSync } from "node:fs";
import { AbiCoder, Interface, keccak256, toQuantity, id as hashText } from "ethers";
import { ApiError, json, type Assignment, type Block, type ChainSnapshot, type Order } from "../domain.js";

const deploymentVersion = process.env.PAYUNLOCK_DEPLOYMENT_VERSION === "v5" ? "v5" : "v4";
const artifact = JSON.parse(readFileSync(new URL(deploymentVersion === "v5"
  ? "../../../payunlock-contract/abi/PayUnlock.json"
  : "../../../payunlock-contract/ignition/deployments/monad-testnet-payunlock-v4/artifacts/PayUnlockV1%23PayUnlock.json", import.meta.url), "utf8"));
export const deployment = JSON.parse(readFileSync(new URL(`../../../payunlock-contract/deployments/monad-testnet-payunlock-${deploymentVersion}.json`, import.meta.url), "utf8")) as { chainId: number; escrow: string; deploymentBlock: number; admin: string; router?: string; usdc?: string };
export const escrowAddress = deployment.escrow.toLowerCase();
export const deploymentKey = `${deployment.chainId}:${escrowAddress}`;
export const escrowInterface = new Interface(artifact.abi);
const iface = escrowInterface;
const plain = <T>(value: unknown): T => JSON.parse(json(value)) as T;
class RpcRevert extends Error { constructor(public data: string | undefined) { super("RPC_REVERT"); } }
type Receipt = { status: string; blockNumber: string; blockHash: string; transactionHash: string; to: string; from: string; logs: { address: string; topics: string[]; data: string }[] };
type RawBlock = { number: string; hash: string; timestamp: string };
export interface CheckoutConfiguration {
  chainId: number; contract: string; seller: string; productKey: string; expectedTerms: string;
  terms: Order["terms"]; sellerReceiving: Order["sellerReceiving"]; status: number; allowed: boolean; block: Block;
  productTerms?: { token: string; price: string; hasEventEnd: boolean; eventEnd: string; hasReviewOverride: boolean; reviewOverride: string; commitmentWindow: string };
  authorizationMode?: "eip3009-receive" | "direct-only";
  serviceFee?: { bps: number; treasury: string; sellerCapBps: number };
}

export class ChainService {
  readonly metrics = { requests: 0, failures: 0, reverts: 0, rateLimits: 0 };
  constructor(private url: string, private fetcher: typeof fetch = fetch) {}
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    this.metrics.requests++;
    try {
      const response = await this.fetcher(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10000) });
      if (response.status === 429) this.metrics.rateLimits++;
      if (!response.ok) throw new ApiError(503, "CHAIN_UNAVAILABLE");
      const body = await response.json() as { result?: T; error?: { code?: number; data?: unknown } };
      if (body.error) {
        if (body.error.code === 429 || body.error.code === -32005) this.metrics.rateLimits++;
        if (typeof body.error.data === "string" && body.error.data.startsWith("0x")) throw new RpcRevert(body.error.data);
        throw new ApiError(503, "CHAIN_UNAVAILABLE");
      }
      if (!("result" in body)) throw new ApiError(503, "CHAIN_UNAVAILABLE");
      return body.result as T;
    } catch (error) {
      if (error instanceof RpcRevert) this.metrics.reverts++; else this.metrics.failures++;
      if (error instanceof RpcRevert || error instanceof ApiError) throw error;
      throw new ApiError(503, "CHAIN_UNAVAILABLE");
    }
  }
  async block(tag: string): Promise<Block> {
    const value = await this.rpc<RawBlock | null>("eth_getBlockByNumber", [tag, false]);
    if (!value?.hash || !value.number || !value.timestamp) throw new ApiError(503, "CHAIN_UNCERTAIN");
    return { number: Number(BigInt(value.number)), hash: value.hash, timestamp: Number(BigInt(value.timestamp)) };
  }
  async anchor(tag = "finalized"): Promise<Block> {
    if (await this.rpc<string>("eth_chainId", []) !== toQuantity(deployment.chainId)) throw new ApiError(503, "WRONG_CHAIN");
    return this.block(tag);
  }
  async ensureCanonical(block: Block) {
    if ((await this.block(toQuantity(block.number))).hash !== block.hash) throw new ApiError(503, "CHAIN_UNCERTAIN");
  }
  async call(name: string, args: unknown[], block: Block) {
    const raw = await this.rpc<string>("eth_call", [{ to: escrowAddress, data: iface.encodeFunctionData(name, args) }, toQuantity(block.number)]);
    return iface.decodeFunctionResult(name, raw);
  }
  async isEOA(wallet: string) {
    const block = await this.anchor();
    const code = await this.rpc<string>("eth_getCode", [wallet, toQuantity(block.number)]);
    await this.ensureCanonical(block);
    return code === "0x";
  }
  async policies(tag = "finalized") {
    const block = await this.anchor(tag);
    const names = ["owner", "defaultReviewWindow", "responseWindow", "minResponseWindow", "minCommitmentWindow", "maxCommitmentWindow", "batchLimit", "MAX_BATCH"] as const;
    const values = await Promise.all(names.map(name => this.call(name, [], block)));
    const feeNames = ["serviceFeeBps", "feeTreasury", "offerPlacementFee", "placementFeeVersion", "arbitrationFeeAsset"] as const;
    const feeValues = deployment.router ? await Promise.all(feeNames.map(name => this.call(name, [], block))) : undefined;
    await this.ensureCanonical(block);
    return { owner: String(values[0]![0]).toLowerCase(), reviewWindow: String(values[1]![0]), responseWindow: String(values[2]![0]), minResponseWindow: String(values[3]![0]), minCommitmentWindow: Number(values[4]![0]), maxCommitmentWindow: Number(values[5]![0]), batchLimit: Number(values[6]![0]), maxBatch: Number(values[7]![0]),
      ...(feeValues ? { serviceFeeBps: Number(feeValues[0]![0]), feeTreasury: String(feeValues[1]![0]).toLowerCase(), offerPlacementFee: String(feeValues[2]![0]), placementFeeVersion: String(feeValues[3]![0]), arbitrationFeeAsset: String(feeValues[4]![0]).toLowerCase() } : {}), block };
  }
  async configuration(seller: string, productKey: string): Promise<CheckoutConfiguration> {
    const block = await this.anchor();
    try {
      const [productResult, termsResult, expected] = await Promise.all([this.call("getProduct", [seller, productKey], block), this.call("currentTerms", [seller, productKey], block), this.call("checkoutHash", [seller, productKey], block)]);
      const product = productResult[0].toObject(true);
      const terms = plain<Order["terms"]>(termsResult[0].toObject(true));
      const allowed = (await this.call("allowedAssets", [terms.token], block))[0] as boolean;
      const authorizationMode = deployment.router ? (await this.call("receiveAuthorizationAssets", [terms.token], block))[0] ? "eip3009-receive" as const : "direct-only" as const : undefined;
      const feeResults = deployment.router ? await Promise.all([this.call("serviceFeeBps", [], block), this.call("feeTreasury", [], block), this.call("sellerFeeCapBps", [seller, productKey], block)]) : undefined;
      const serviceFee = feeResults ? { bps: Number(feeResults[0]![0]), treasury: String(feeResults[1]![0]).toLowerCase(), sellerCapBps: Number(feeResults[2]![0]) } : undefined;
      await this.ensureCanonical(block);
      return { chainId: deployment.chainId, contract: escrowAddress, seller, productKey, expectedTerms: expected[0] as string,
        terms, productTerms: plain(product.terms), sellerReceiving: plain(product.receiving), status: Number(product.status), allowed, block, authorizationMode, serviceFee };
    } catch (error) { return this.notFound(error); }
  }
  private notFound(error: unknown): never {
    if (error instanceof RpcRevert && error.data?.startsWith(iface.getError("NotFound")!.selector)) throw new ApiError(404, "CHAIN_RECORD_NOT_FOUND");
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "CHAIN_UNCERTAIN");
  }
  async order(id: string, tag = "finalized"): Promise<ChainSnapshot> {
    const block = await this.anchor(tag);
    const snapshot = await this.orderAt(id, block);
    await this.ensureCanonical(block);
    return snapshot;
  }
  async orders(ids: string[], tag = "finalized"): Promise<ChainSnapshot[]> {
    if (ids.length > 30) throw new ApiError(400, "BATCH_TOO_LARGE");
    const block = await this.anchor(tag), products = new Map<string, Promise<boolean>>(), result: ChainSnapshot[] = [];
    for (let i = 0; i < ids.length; i += 3) result.push(...await Promise.all(ids.slice(i, i + 3).map(id => this.orderAt(id, block, products))));
    await this.ensureCanonical(block); return result;
  }
  private async orderAt(id: string, block: Block, products?: Map<string, Promise<boolean>>): Promise<ChainSnapshot> {
    try {
      const value = (await this.call("getOrder", [id], block))[0].toObject(true);
      const order = { ...plain<Order>(value), state: Number(value.state), buyer: value.buyer.toLowerCase(), seller: value.seller.toLowerCase() };
      const key = `${order.seller}:${order.productKey}`;
      const product = products?.get(key) ?? this.call("getProduct", [order.seller, order.productKey], block).then(value => Number(value[0].status) === 3);
      products?.set(key, product);
      const canceled = await product;
      let assignment: Assignment | undefined;
      try { if (!products || order.state >= 6) { const result = (await this.call("getAssignment", [id], block))[0].toObject(true); assignment = { ...plain<Assignment>(result), wallet: result.wallet.toLowerCase() }; } }
      catch (error) { if (!(error instanceof RpcRevert && error.data?.startsWith(iface.getError("NotFound")!.selector))) throw error; }
      return { block, order, assignment, canceled };
    } catch (error) { return this.notFound(error); }
  }
  async batchPublication(items: { orderId: string; reservationTransaction: string }[], wallet: string, latest: ChainSnapshot[]) {
    const finalized = await this.orders(items.map(i => i.orderId));
    const transactions = new Map<string, Awaited<ReturnType<ChainService["transaction"]>>>();
    for (const hash of new Set(items.map(i => i.reservationTransaction))) transactions.set(hash, await this.transaction(hash, wallet));
    return items.map((item, i) => {
      const tx = transactions.get(item.reservationTransaction)!;
      if (tx.status !== "finalized_success") return false;
      const event = tx.receipt.logs.filter(l => l.address.toLowerCase() === escrowAddress).map(l => { try { return iface.parseLog(l); } catch { return null; } }).find(l => l?.name === "DeliveryReserved" && String(l.args.orderId) === item.orderId);
      return Boolean(event) && [finalized[i]!, latest[i]!].every(s => s.order.seller === wallet && s.order.state === 2 && !s.canceled && BigInt(s.order.publicationDeadline) === BigInt(event!.args.publicationDeadline) && BigInt(s.order.publicationDeadline) > BigInt(s.block.timestamp));
    });
  }
  async recover(buyer: string, requestId: string) {
    const block = await this.anchor();
    const id = String((await this.call("orderForRequest", [buyer, requestId], block))[0]);
    await this.ensureCanonical(block);
    if (id === "0") return { status: "uncertain" as const, requestId, finalizedBlock: block.number };
    const snapshot = await this.order(id);
    if (snapshot.order.buyer !== buyer || snapshot.order.requestId !== requestId) throw new ApiError(503, "CHAIN_UNCERTAIN");
    return { status: "finalized" as const, orderId: id, snapshot };
  }
  async transaction(hash: string, wallet: string, target = escrowAddress) {
    const block = await this.anchor();
    const receipt = await this.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (!receipt) return { status: "uncertain" as const };
    if (receipt.from.toLowerCase() !== wallet || receipt.to?.toLowerCase() !== target) throw new ApiError(403, "TRANSACTION_NOT_OWNED");
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new ApiError(503, "CHAIN_UNCERTAIN");
    if (Number(BigInt(receipt.blockNumber)) > block.number) return { status: "provisional" as const };
    const canonical = await this.block(receipt.blockNumber);
    const again = await this.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (canonical.number !== Number(BigInt(receipt.blockNumber)) || canonical.hash !== receipt.blockHash || !again || again.transactionHash !== receipt.transactionHash || again.blockNumber !== receipt.blockNumber || again.blockHash !== receipt.blockHash || again.status !== receipt.status || !["0x0", "0x1"].includes(receipt.status)) return { status: "uncertain" as const };
    await this.ensureCanonical(block);
    return { status: receipt.status === "0x1" ? "finalized_success" as const : "finalized_revert" as const,
      blockNumber: canonical.number, blockHash: canonical.hash, receipt };
  }
  async publication(id: string, txHash: string, wallet: string) {
    const tx = await this.transaction(txHash, wallet);
    if (tx.status !== "finalized_success") return { eligible: false, reason: tx.status };
    const commitment = tx.receipt.logs.filter(l => l.address.toLowerCase() === escrowAddress).map(l => { try { return iface.parseLog(l); } catch { return null; } }).find(l => l?.name === "DeliveryReserved" && String(l.args.orderId) === id);
    const [finalized, latest] = await Promise.all([this.order(id), this.order(id, "latest")]);
    if (finalized.order.seller !== wallet) throw new ApiError(403, "FORBIDDEN");
    const eligible = Boolean(commitment) && [finalized, latest].every(s => s.order.state === 2 && !s.canceled && BigInt(s.order.publicationDeadline) === BigInt(commitment!.args.publicationDeadline) && BigInt(s.order.publicationDeadline) > BigInt(s.block.timestamp));
    return { eligible, reason: eligible ? "finalized_reservation" : "order_changed_or_expired", checkedBlock: latest.block.number, publicationDeadline: latest.order.publicationDeadline };
  }
}

export function checkoutHashForOrder(order: Order) {
  return keccak256(AbiCoder.defaultAbiCoder().encode([
    "string", "uint256", "address", "address", "bytes32",
    "tuple(address token,uint256 price,bool hasEventEnd,uint64 eventEnd,uint64 reviewWindow,uint64 responseWindow,uint32 commitmentWindow)",
    "tuple(bytes32 nonce,bytes32 publicKey)", "bytes32",
  ], ["payunlock-checkout-v1", deployment.chainId, escrowAddress, order.seller, order.productKey, order.terms, order.sellerReceiving,
    hashText("payunlock-storage-v1:31536000:preparation:no-managers")]));
}

export function eligibility(snapshot: ChainSnapshot, wallet: string) {
  const { order: o, canceled, block } = snapshot;
  const buyer = wallet === o.buyer, seller = wallet === o.seller, now = BigInt(block.timestamp);
  const responseExpired = now >= BigInt(o.responseDeadline);
  const negotiating = o.state === 4 || o.state === 5;
  return {
    claimRefund: buyer && (o.state === 1 || (o.state === 2 && (canceled || now >= BigInt(o.publicationDeadline)))),
    withdrawSeller: seller && (o.state === 7 || (o.state === 3 && now >= BigInt(o.reviewDeadline))),
    openDispute: buyer && o.state === 3 && now < BigInt(o.reviewDeadline),
    reply: negotiating && !responseExpired && (o.state === 4 ? seller : buyer),
    claimResponseTimeout: negotiating && responseExpired && (o.state === 4 ? buyer : seller),
    requestArbitration: (buyer || seller) && negotiating && !responseExpired,
    confirmReceipt: buyer && (o.state === 3 || negotiating) && !(o.state === 4 && responseExpired),
    refundDisputedOrder: seller && negotiating && !(o.state === 5 && responseExpired),
    resolveArbitration: o.state === 6 && snapshot.assignment?.wallet === wallet,
  };
}
