// Live protocol acceptance against Circle's Monad Testnet USDC. The buyer has no MON.
// Run `prepare` before obtaining faucet USDC, then `purchase` with backend + worker online.
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, id, formatUnits, parseEther, type InterfaceAbi } from "ethers";
import { waitFinalized } from "./finality.js";

const key = id("payunlock-v5-circle-live-acceptance-product-1");
const requestId = id("payunlock-v5-circle-live-acceptance-purchase-1");
const sellerReceiving = { nonce: id("payunlock-v5-live-seller-nonce"), publicKey: id("payunlock-v5-live-seller-key") };
const buyerReceiving = { nonce: id("payunlock-v5-live-buyer-nonce"), publicKey: id("payunlock-v5-live-buyer-key") };
const price = 1_000_000n;
const buyerAddress = "0xb0D81dE35BefEce734c094BBe50B8c6748339517";
let stage = "configuration";

async function main() {
  const mode = process.argv[2];
  if (mode !== "prepare" && mode !== "purchase" && mode !== "verify" && mode !== "third-party") throw new Error("Select prepare, purchase, verify, or third-party");
  if (!process.env.MONAD_TESTNET_RPC_URL || !process.env.MONAD_TESTNET_DEPLOYER_KEY || !process.env.V5_ACCEPTANCE_BUYER_KEY) throw new Error("Local V5 acceptance configuration is missing");
  const manifest = JSON.parse(await readFile(resolve("deployments/monad-testnet-payunlock-v5.json"), "utf8")) as { chainId: number; escrow: string; router: string; usdc: string; admin: string };
  if (manifest.chainId !== 10143) throw new Error("Wrong deployment");
  const provider = new JsonRpcProvider(process.env.MONAD_TESTNET_RPC_URL, 10143);
  try {
    if ((await provider.getNetwork()).chainId !== 10143n) throw new Error("Wrong chain");
    const seller = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY, provider), buyer = new Wallet(process.env.V5_ACCEPTANCE_BUYER_KEY, provider);
    if (seller.address.toLowerCase() !== manifest.admin.toLowerCase() || buyer.address.toLowerCase() !== buyerAddress.toLowerCase()) throw new Error("Acceptance wallet mismatch");
    const escrowArtifact = JSON.parse(await readFile(resolve("abi/PayUnlock.json"), "utf8")) as { abi: InterfaceAbi };
    const routerArtifact = JSON.parse(await readFile(resolve("abi/PayUnlockAuthorizationRouter.json"), "utf8")) as { abi: InterfaceAbi };
    const escrow = new Contract(manifest.escrow, escrowArtifact.abi, seller);
    const router = new Contract(manifest.router, routerArtifact.abi, provider);
    const usdc = new Contract(manifest.usdc, ["function balanceOf(address) view returns (uint256)"], provider);
    if (mode === "prepare") {
      try {
        await escrow.getFunction("getProduct").staticCall(seller.address, key);
        console.log(JSON.stringify({ stage: "prepared", productKey: key, existing: true }));
        return;
      } catch { /* The deterministic acceptance offer is not yet on-chain. */ }
      const placementFee = await escrow.getFunction("offerPlacementFee").staticCall();
      const placementVersion = await escrow.getFunction("placementFeeVersion").staticCall();
      const terms = { token: manifest.usdc, price, hasEventEnd: false, eventEnd: 0, hasReviewOverride: false, reviewOverride: 0, commitmentWindow: 600 };
      const transaction = await escrow.getFunction("createProduct")!(key, terms, sellerReceiving, 300, placementFee, placementVersion, { value: placementFee });
      const receipt = await waitFinalized(provider, transaction.hash);
      if (receipt.status !== 1) throw new Error("Offer creation reverted");
      console.log(JSON.stringify({ stage: "prepared", productKey: key, transactionHash: transaction.hash, finalizedBlock: receipt.blockNumber }));
      return;
    }
    const currentRequestId = mode === "third-party" ? id("payunlock-v5-circle-live-acceptance-purchase-2") : requestId;
    const existingOrder = await escrow.getFunction("orderForRequest").staticCall(buyer.address, currentRequestId, { blockTag: "finalized" });
    if (mode === "verify" || existingOrder !== 0n) {
      const balance = await provider.getBalance(buyer.address, "finalized");
      console.log(JSON.stringify({ stage: "verified", orderId: String(existingOrder), buyerMon: balance.toString(),
        buyerUSDC: formatUnits(await usdc.getFunction("balanceOf").staticCall(buyer.address), 6) }));
      if (existingOrder === 0n || balance !== 0n) throw new Error("Purchase has not met zero-MON acceptance criteria");
      return;
    }
    const buyerMon = await provider.getBalance(buyer.address, "finalized"), buyerUSDC = await usdc.getFunction("balanceOf").staticCall(buyer.address);
    if (buyerMon !== 0n || buyerUSDC < price) throw new Error("Buyer must have at least 1 USDC and zero MON");
    const checkoutHash = await escrow.getFunction("checkoutHash").staticCall(seller.address, key);
    const intent = { seller: seller.address, productKey: key, requestId: currentRequestId, expectedCheckoutHash: checkoutHash, receiving: buyerReceiving };
    const authorization = { actor: buyer.address, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      salt: id(mode === "third-party" ? "payunlock-v5-circle-live-acceptance-salt-2" : "payunlock-v5-circle-live-acceptance-salt-1"), signature: "0x" };
    const nonce = await router.getFunction("purchaseNonce").staticCall(intent, authorization);
    authorization.signature = await buyer.signTypedData({ name: "USDC", version: "2", chainId: 10143, verifyingContract: manifest.usdc },
      { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      { from: buyer.address, to: manifest.router, value: price, validAfter: authorization.validAfter, validBefore: authorization.validBefore, nonce });
    if (mode === "third-party") {
      stage = "independent-relayer-setup";
      let thirdParty: Wallet;
      if (process.env.V5_THIRD_PARTY_RELAYER_KEY) thirdParty = new Wallet(process.env.V5_THIRD_PARTY_RELAYER_KEY, provider);
      else {
        thirdParty = new Wallet(Wallet.createRandom().privateKey, provider);
        await appendFile(resolve("../.env"), `\nV5_THIRD_PARTY_RELAYER_KEY=${thirdParty.privateKey}\n`);
      }
      stage = "independent-relayer-funding";
      const balance = await provider.getBalance(thirdParty.address, "finalized");
      if (balance < parseEther("0.5")) {
        const funding = await seller.sendTransaction({ to: thirdParty.address, value: parseEther("0.5") - balance });
        await waitFinalized(provider, funding.hash);
      }
      stage = "independent-relayer-submit";
      const independentRouter = new Contract(manifest.router, routerArtifact.abi, thirdParty);
      const transaction = await independentRouter.getFunction("purchaseWithAuthorization")!(intent, authorization);
      stage = "independent-relayer-finality";
      const receipt = await waitFinalized(provider, transaction.hash);
      const orderId = await escrow.getFunction("orderForRequest").staticCall(buyer.address, currentRequestId, { blockTag: "finalized" });
      if (receipt.status !== 1 || orderId === 0n || await provider.getBalance(buyer.address, "finalized") !== 0n) throw new Error("Independent relay effect mismatch");
      console.log(JSON.stringify({ stage: "independent-relay", thirdParty: thirdParty.address, orderId: String(orderId),
        transactionHash: transaction.hash, buyerMon: "0", buyerUSDC: formatUnits(await usdc.getFunction("balanceOf").staticCall(buyer.address), 6) }));
      return;
    }
    const packet = { kind: "purchase", chainId: 10143, escrow: manifest.escrow, router: manifest.router, intent, authorization };
    const origin = "http://127.0.0.1:4320", api = "http://127.0.0.1:4321/v1";
    const response = await fetch(`${api}/relay/payments`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(packet) });
    if (!response.ok) throw new Error(`Relayer API rejected purchase: HTTP ${response.status}`);
    const job = await response.json() as { id: string; status: string; transactionHash?: string };
    console.log(JSON.stringify({ stage: "queued", id: job.id, nonce, buyer: buyer.address }));
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await fetch(`${api}/relay/jobs/${job.id}`, { headers: { origin } });
      if (!result.ok) throw new Error(`Relayer status failed: HTTP ${result.status}`);
      const state = await result.json() as { status: string; transactionHash?: string };
      if (state.status === "finalized") {
        const orderId = await escrow.getFunction("orderForRequest").staticCall(buyer.address, currentRequestId, { blockTag: "finalized" });
        if (orderId === 0n || await provider.getBalance(buyer.address, "finalized") !== 0n) throw new Error("Finalized effect or buyer gas balance mismatch");
        console.log(JSON.stringify({ stage: "purchased", orderId: String(orderId), transactionHash: state.transactionHash, buyerMon: "0",
          buyerUSDC: formatUnits(await usdc.getFunction("balanceOf").staticCall(buyer.address), 6) }));
        return;
      }
      if (state.status === "failed") throw new Error("Relayer job failed");
    }
    throw new Error("Relayer job remains pending or uncertain");
  } finally { provider.destroy(); }
}
main().catch(error => { const detail = error && typeof error === "object" ? error as { code?: string; reason?: string; revert?: { name?: string }; error?: { code?: number; message?: string }; info?: { error?: { code?: number; message?: string } } } : {};
  const rpcMessage = detail.info?.error?.message ?? detail.error?.message ?? "";
  console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown", code: detail.code, revert: detail.revert?.name,
    errorFields: error && typeof error === "object" ? Object.keys(error) : [], infoFields: detail.info ? Object.keys(detail.info) : [],
    rpcCode: detail.info?.error?.code ?? detail.error?.code, rpcCategory: /insufficient funds/i.test(rpcMessage) ? "insufficient-funds" : /nonce/i.test(rpcMessage) ? "nonce" : /revert/i.test(rpcMessage) ? "revert" : /underpriced|fee/i.test(rpcMessage) ? "fee" : /already known/i.test(rpcMessage) ? "already-known" : undefined,
    rpcDetail: rpcMessage.replace(/https?:\/\/\S+/g, "[url]").replace(/0x[0-9a-fA-F]{64,}/g, "[hex]").slice(0, 180),
  reason: error instanceof Error && /^(Buyer must|Relayer API rejected|Relayer status failed|Relayer job failed|Relayer job remains|Finalized effect)/.test(error.message) ? error.message : undefined })); process.exitCode = 1; });
