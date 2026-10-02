import { describe, expect, it, vi } from "vitest";
import { Interface, Transaction, Wallet } from "ethers";
import { CatalogRepository } from "../src/repositories/catalog-repository.js";
import { ChainService, escrowAddress, escrowInterface, type CheckoutConfiguration } from "../src/services/chain-service.js";
import { TransactionService } from "../src/services/transaction-service.js";
const hash = `0x${"11".repeat(32)}`, buyer = Wallet.createRandom(), seller = Wallet.createRandom().address.toLowerCase();
const wallet = buyer.address.toLowerCase();
function fixture() {
  const chain = new ChainService("https://unused.invalid"), catalog = Object.create(CatalogRepository.prototype) as CatalogRepository;
  const configuration: CheckoutConfiguration = { chainId: 10143, contract: escrowAddress, seller, productKey: hash, expectedTerms: hash, status: 1, allowed: true, authorizationMode: "direct-only", serviceFee: { bps: 0, treasury: seller, sellerCapBps: 0 }, block: { number: 1, hash, timestamp: 1 }, sellerReceiving: { nonce: hash, publicKey: hash }, terms: { token: "0x0000000000000000000000000000000000000000", price: "1000", hasEventEnd: false, eventEnd: "0", reviewWindow: "0", responseWindow: "60", commitmentWindow: "60" } };
  vi.spyOn(catalog, "intent").mockResolvedValue({ id: "intent", product_id: "product", buyer: wallet, request_id: hash, revision: 1, expected_terms: hash, buyer_receiving: configuration.sellerReceiving, configuration });
  vi.spyOn(catalog, "review").mockResolvedValue(undefined);
  vi.spyOn(chain, "recover").mockResolvedValue({ status: "uncertain", requestId: hash, finalizedBlock: 1 });
  vi.spyOn(chain, "configuration").mockResolvedValue(configuration);
  vi.spyOn(chain, "anchor").mockResolvedValue(configuration.block);
  vi.spyOn(chain, "policies").mockResolvedValue({ owner: seller, reviewWindow: "86400", responseWindow: "259200", minResponseWindow: "60", minCommitmentWindow: 60, maxCommitmentWindow: 86400, batchLimit: 30, maxBatch: 30, serviceFeeBps: 0, feeTreasury: seller, offerPlacementFee: "0", placementFeeVersion: "1", arbitrationFeeAsset: configuration.terms.token, block: configuration.block });
  return { chain, catalog, configuration, service: new TransactionService(chain, catalog) };
}
describe("bounded wallet transactions", () => {
  it("binds purchase calldata and exact native value to the persisted request and receiving identity", async () => {
    const { service } = fixture();
    const result = await service.request(wallet, { kind: "purchase", requestId: hash, expectedTerms: hash });
    const decoded = escrowInterface.decodeFunctionData("purchase", result.data);
    expect(decoded[2]).toBe(hash); expect(decoded[4].nonce).toBe(hash); expect(result.value).toBe("1000");
  });
  it("requires renewed review when defaults change and rejects disabled or already funded purchases", async () => {
    const { service, chain, configuration } = fixture(), action = { kind: "purchase" as const, requestId: hash, expectedTerms: hash };
    vi.mocked(chain.configuration).mockResolvedValueOnce({ ...configuration, expectedTerms: `0x${"22".repeat(32)}` });
    await expect(service.request(wallet, action)).rejects.toMatchObject({ code: "TERMS_CHANGED_REVIEW_AGAIN" });
    vi.mocked(chain.configuration).mockResolvedValueOnce({ ...configuration, status: 2 });
    await expect(service.request(wallet, action)).rejects.toMatchObject({ code: "SALES_UNAVAILABLE" });
    vi.mocked(chain.recover).mockResolvedValueOnce({ status: "finalized", orderId: "1", snapshot: {} as never });
    await expect(service.request(wallet, action)).rejects.toMatchObject({ code: "PURCHASE_ALREADY_FINALIZED" });
  });
  it("uses exact ERC20 approval and zero MON payment", async () => {
    const { service, configuration } = fixture(); configuration.terms.token = seller;
    const approval = await service.request(wallet, { kind: "approve", requestId: hash, expectedTerms: hash });
    expect(approval.to).toBe(seller); expect(approval.value).toBe("0");
    expect((await service.request(wallet, { kind: "purchase", requestId: hash, expectedTerms: hash })).value).toBe("0");
  });
  it("rejects insufficient gas funds and raw transactions altered after review", async () => {
    const { service, chain } = fixture(), action = { kind: "purchase" as const, requestId: hash, expectedTerms: hash };
    vi.spyOn(chain, "rpc").mockResolvedValue("0x1");
    await expect(service.prepare(wallet, action)).rejects.toMatchObject({ code: "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS" });
    const tx = await service.request(wallet, action);
    const raw = await buyer.signTransaction({ to: tx.to, data: tx.data, value: 1001n, chainId: 10143, nonce: 0, gasLimit: 1000000, gasPrice: 1 });
    expect(Transaction.from(raw).from?.toLowerCase()).toBe(wallet);
    await expect(service.broadcast(wallet, action, raw)).rejects.toMatchObject({ code: "SIGNED_TRANSACTION_MISMATCH" });
    expect(vi.mocked(chain.rpc).mock.calls.some(([method]) => method === "eth_sendRawTransaction")).toBe(false);
  });
});

it("requires offer correction when admin bounds change without changing purchased terms", async () => {
  const { chain, service } = fixture();
  const p = await chain.policies(); vi.mocked(chain.policies).mockResolvedValue({ ...p, minCommitmentWindow: 120 });
  await expect(service.request(wallet, { kind: "purchase", requestId: hash, expectedTerms: hash })).rejects.toMatchObject({ code: "OFFER_OUTSIDE_CURRENT_BOUNDS" });
});

it("reports disabled MON from the contract instead of assuming it is enabled", async () => {
  const { chain, service } = fixture();
  vi.spyOn(chain, "rpc").mockResolvedValue("0x1");
  vi.spyOn(chain, "call").mockResolvedValue([false] as never);
  vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
  expect((await service.asset(wallet, "0x0000000000000000000000000000000000000000")).allowed).toBe(false);
});

it("reads only public token metadata at a canonical block", async () => {
  const { chain, service } = fixture();
  const abi = new Interface(["function symbol() view returns(string)", "function decimals() view returns(uint8)"]);
  const calls = vi.spyOn(chain, "rpc").mockImplementation(async (_method, params) => {
    const tx = params[0] as { data: string };
    return abi.encodeFunctionResult(tx.data === abi.encodeFunctionData("symbol") ? "symbol" : "decimals", tx.data === abi.encodeFunctionData("symbol") ? ["USDC"] : [6]) as never;
  });
  const canonical = vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
  expect(await service.assetMetadata(seller)).toEqual({ token: seller, symbol: "USDC", decimals: 6 });
  expect(calls).toHaveBeenCalledTimes(2); expect(canonical).toHaveBeenCalled();
});
it("rejects token metadata that cannot be safely formatted", async () => {
  const { chain, service } = fixture();
  const abi = new Interface(["function symbol() view returns(string)", "function decimals() view returns(uint8)"]);
  vi.spyOn(chain, "rpc").mockImplementation(async (_method, params) => {
    const symbol = (params[0] as { data: string }).data === abi.encodeFunctionData("symbol");
    return abi.encodeFunctionResult(symbol ? "symbol" : "decimals", symbol ? ["TOKEN"] : [255]) as never;
  });
  vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
  await expect(service.assetMetadata(seller)).rejects.toMatchObject({ code: "TOKEN_METADATA_UNAVAILABLE" });
});
