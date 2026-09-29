import { Interface, Transaction, toQuantity, ZeroAddress } from "ethers";
import { z } from "zod";
import { ApiError, address, nonzeroHash, orderId, receiving } from "../domain.js";
import { CatalogRepository } from "../repositories/catalog-repository.js";
import { ChainService, deployment, escrowAddress, escrowInterface, eligibility } from "./chain-service.js";
import { lifecycleSchemas, lifecycleSchema, lifecycleRequest } from "./lifecycle-actions.js";

const erc20 = new Interface(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns(uint256)", "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function symbol() view returns(string)"]);
export const actionSchema = z.discriminatedUnion("kind", [
  ...lifecycleSchemas,
  z.strictObject({ kind: z.literal("create"), productId: z.uuid(), receiving, feeCapBps: z.number().int().min(0).max(10000).optional(), expectedPlacementFee: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(), expectedFeeVersion: z.string().regex(/^(0|[1-9][0-9]*)$/).optional() }),
  z.strictObject({ kind: z.literal("update"), productId: z.uuid(), receiving }),
  z.strictObject({ kind: z.literal("disable"), productId: z.uuid(), disabled: z.boolean() }),
  z.strictObject({ kind: z.enum(["purchase", "approve"]), requestId: nonzeroHash, expectedTerms: nonzeroHash }),
  z.strictObject({ kind: z.literal("approveArbitrationFee"), orderId, arbitrator: address, expectedFee: z.string().regex(/^(0|[1-9][0-9]*)$/), expectedFeeAsset: address }),
  z.strictObject({ kind: z.enum(["claimRefund", "claimResponseTimeout", "withdrawSeller"]), orderId }),
]);
export type Action = z.infer<typeof actionSchema>;
export class TransactionService {
  constructor(private chain: ChainService, private catalog: CatalogRepository) {}
  async request(wallet: string, action: Action) {
    let to = escrowAddress, value = "0", data: string;
    const lifecycle = lifecycleSchema.safeParse(action);
    if (lifecycle.success) {
      const prepared = await lifecycleRequest(this.chain, wallet, lifecycle.data); data = prepared.data; value = prepared.value;
    } else if (action.kind === "create" || action.kind === "update" || action.kind === "disable") {
      const p = await this.catalog.get(action.productId, wallet), m = await this.catalog.mapping(p.id);
      if (action.kind === "disable") data = escrowInterface.encodeFunctionData("setSalesDisabled", [m.product_key, action.disabled]);
      else {
        const t = p.draft_terms;
        const policies = await this.chain.policies("latest");
        if (t.commitmentWindow < policies.minCommitmentWindow || t.commitmentWindow > policies.maxCommitmentWindow) throw new ApiError(409, "PUBLICATION_BOUNDS_CHANGED_UPDATE_OFFER");
        const args: unknown[] = [m.product_key, { token: t.token, price: t.price, hasEventEnd: t.eventEnd !== null, eventEnd: t.eventEnd ?? "0", hasReviewOverride: t.reviewWindow !== null, reviewOverride: t.reviewWindow ?? "0", commitmentWindow: t.commitmentWindow }, action.receiving];
        if (action.kind === "create" && deployment.router) {
          if (action.feeCapBps === undefined || action.expectedPlacementFee === undefined || action.expectedFeeVersion === undefined || action.feeCapBps < policies.serviceFeeBps!) throw new ApiError(409, "FEE_REVIEW_REQUIRED");
          if (action.expectedPlacementFee !== policies.offerPlacementFee || action.expectedFeeVersion !== policies.placementFeeVersion) throw new ApiError(409, "PLACEMENT_FEE_CHANGED");
          args.push(action.feeCapBps, action.expectedPlacementFee, action.expectedFeeVersion);
          value = action.expectedPlacementFee;
        }
        data = escrowInterface.encodeFunctionData(action.kind === "create" ? "createProduct" : "updateProduct", args);
      }
    } else if (action.kind === "approveArbitrationFee") {
      if (!deployment.router) throw new ApiError(409, "ACTION_NOT_AVAILABLE");
      const block = await this.chain.anchor("latest");
      const snapshot = await this.chain.order(action.orderId, "latest");
      if (!eligibility(snapshot, wallet).requestArbitration) throw new ApiError(409, "ACTION_NOT_AVAILABLE");
      const asset = String((await this.chain.call("arbitrationFeeAsset", [], block))[0]).toLowerCase();
      const arbitrator = await this.chain.call("arbitrators", [action.arbitrator], block);
      if (asset !== action.expectedFeeAsset || !arbitrator[0] || BigInt(arbitrator[3]) !== BigInt(action.expectedFee)) throw new ApiError(409, "ARBITRATION_FEE_CHANGED");
      await this.chain.ensureCanonical(block);
      to = asset; data = erc20.encodeFunctionData("approve", [escrowAddress, action.expectedFee]);
    } else if (action.kind === "purchase" || action.kind === "approve") {
      const intent = await this.catalog.intent(wallet, action.requestId);
      if (!intent) throw new ApiError(404, "CHECKOUT_NOT_FOUND");
      const review = await this.catalog.review(intent.id, action.expectedTerms);
      const config = review?.configuration ?? (intent.expected_terms === action.expectedTerms ? intent.configuration : undefined);
      if (!config) throw new ApiError(409, "REVIEW_REQUIRED");
      if ((await this.chain.recover(wallet, action.requestId)).status === "finalized") throw new ApiError(409, "PURCHASE_ALREADY_FINALIZED");
      const current = await this.chain.configuration(config.seller, config.productKey);
      if (current.status !== 1 || !current.allowed) throw new ApiError(409, "SALES_UNAVAILABLE");
      const policies = await this.chain.policies("latest");
      if (BigInt(current.terms.commitmentWindow) < BigInt(policies.minCommitmentWindow) || BigInt(current.terms.commitmentWindow) > BigInt(policies.maxCommitmentWindow)) throw new ApiError(409, "OFFER_OUTSIDE_CURRENT_BOUNDS");
      if (current.expectedTerms !== action.expectedTerms) throw new ApiError(409, "TERMS_CHANGED_REVIEW_AGAIN");
      if (action.kind === "approve") {
        if (config.terms.token === ZeroAddress) throw new ApiError(400, "NATIVE_APPROVAL_NOT_REQUIRED");
        to = config.terms.token.toLowerCase(); data = erc20.encodeFunctionData("approve", [escrowAddress, config.terms.price]);
      } else {
        data = escrowInterface.encodeFunctionData("purchase", [config.seller, config.productKey, action.requestId, action.expectedTerms, intent.buyer_receiving]);
        value = config.terms.token === ZeroAddress ? config.terms.price : "0";
      }
    } else if (action.kind === "claimRefund" || action.kind === "claimResponseTimeout" || action.kind === "withdrawSeller") {
      const snapshot = await this.chain.order(action.orderId, "latest");
      if (!eligibility(snapshot, wallet)[action.kind]) throw new ApiError(409, "ACTION_NOT_AVAILABLE");
      data = escrowInterface.encodeFunctionData(action.kind, [action.orderId]);
    } else throw new ApiError(400, "INVALID_ACTION");
    return { chainId: deployment.chainId, to, data, value };
  }
  async prepare(wallet: string, action: Action) {
    const tx = await this.request(wallet, action);
    await this.chain.anchor("latest");
    const balance = await this.chain.rpc<string>("eth_getBalance", [wallet, "pending"]);
    if (BigInt(balance) <= BigInt(tx.value)) throw new ApiError(409, "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS");
    const [gas, nonce, price, priority] = await Promise.all([
      this.chain.rpc<string>("eth_estimateGas", [{ from: wallet, to: tx.to, data: tx.data, value: toQuantity(BigInt(tx.value)) }]).catch(error => {
        if (error instanceof Error && error.message === "RPC_REVERT" && ["reserveDeliveries", "publishDeliveries", "refundCanceledOrders"].includes(action.kind)) throw new ApiError(409, "BATCH_SIMULATION_FAILED");
        throw error;
      }),
      this.chain.rpc<string>("eth_getTransactionCount", [wallet, "pending"]),
      this.chain.rpc<string>("eth_gasPrice", []),
      this.chain.rpc<string>("eth_maxPriorityFeePerGas", []),
    ]);
    const limit = BigInt(gas) * 12n / 10n, fee = BigInt(price) * 2n;
    if (["reserveDeliveries", "publishDeliveries", "refundCanceledOrders"].includes(action.kind) && limit > 30_000_000n) throw new ApiError(409, "BATCH_GAS_LIMIT");
    if (BigInt(balance) < BigInt(tx.value) + limit * fee) throw new ApiError(409, "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS");
    return { ...tx, gas: String(limit), nonce: Number(BigInt(nonce)), maxFeePerGas: String(fee), maxPriorityFeePerGas: String(BigInt(priority) < fee ? BigInt(priority) : fee), balance: String(BigInt(balance)) };
  }
  async broadcast(wallet: string, action: Action, raw: string) {
    const expected = await this.request(wallet, action), tx = Transaction.from(raw);
    if (tx.from?.toLowerCase() !== wallet || tx.chainId !== BigInt(deployment.chainId) || tx.to?.toLowerCase() !== expected.to.toLowerCase() || tx.data !== expected.data || tx.value !== BigInt(expected.value)) throw new ApiError(400, "SIGNED_TRANSACTION_MISMATCH");
    const hash = await this.chain.rpc<string>("eth_sendRawTransaction", [raw]);
    if (hash !== tx.hash) throw new ApiError(503, "CHAIN_UNCERTAIN");
    return { hash };
  }
  async assetMetadata(token: string) {
    if (token === ZeroAddress) return { token, symbol: "MON", decimals: 18 };
    address.parse(token);
    const block = await this.chain.anchor();
    const read = async (name: string) => erc20.decodeFunctionResult(name, await this.chain.rpc<string>("eth_call", [{ to: token, data: erc20.encodeFunctionData(name) }, toQuantity(block.number)]))[0];
    const [decimals, symbol] = await Promise.all([read("decimals"), read("symbol")]);
    const precision = Number(decimals);
    if (!Number.isInteger(precision) || precision < 0 || precision > 80) throw new ApiError(503, "TOKEN_METADATA_UNAVAILABLE");
    const authorizationProfile = deployment.router && token.toLowerCase() === deployment.usdc?.toLowerCase() && precision === 6 && Boolean((await this.chain.call("receiveAuthorizationAssets", [token], block))[0]) ? { mode: "eip3009-receive" as const, name: "USDC", version: "2" } : undefined;
    await this.chain.ensureCanonical(block);
    return { token, symbol: String(symbol).slice(0, 32), decimals: precision, authorizationProfile };
  }
  async asset(wallet: string, token: string) {
    const block = await this.chain.anchor();
    const nativeBalance = String(BigInt(await this.chain.rpc<string>("eth_getBalance", [wallet, toQuantity(block.number)])));
    if (token === ZeroAddress) {
      const allowed = Boolean((await this.chain.call("allowedAssets", [token], block))[0]);
      await this.chain.ensureCanonical(block);
      return { token, symbol: "MON", decimals: 18, balance: nativeBalance, nativeBalance, allowance: "0", allowed };
    }
    address.parse(token);
    const allowed = Boolean((await this.chain.call("allowedAssets", [token], block))[0]);
    if (!allowed) throw new ApiError(409, "ASSET_NOT_ALLOWED");
    const read = async (name: string, args: unknown[] = []) => erc20.decodeFunctionResult(name, await this.chain.rpc<string>("eth_call", [{ to: token, data: erc20.encodeFunctionData(name, args) }, toQuantity(block.number)]))[0];
    const [decimals, symbol, balance, allowance] = await Promise.all([read("decimals"), read("symbol"), read("balanceOf", [wallet]), read("allowance", [wallet, escrowAddress])]);
    const authorizationProfile = deployment.router && token.toLowerCase() === deployment.usdc?.toLowerCase() && Number(decimals) === 6 && Boolean((await this.chain.call("receiveAuthorizationAssets", [token], block))[0]) ? { mode: "eip3009-receive" as const, name: "USDC", version: "2" } : undefined;
    await this.chain.ensureCanonical(block);
    return { token, decimals: Number(decimals), symbol: String(symbol).slice(0, 32), balance: String(balance), nativeBalance, allowance: String(allowance), allowed, authorizationProfile };
  }
}
