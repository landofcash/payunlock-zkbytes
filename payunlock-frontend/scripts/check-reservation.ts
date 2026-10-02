// Explicit testnet acceptance. Persist only public IDs/receipts; never delivery drafts or keys.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, id, hexlify, randomBytes, keccak256, parseEther } from "ethers";
import { encodeBase64, clearItemKeys } from "@zkbytes/sdk";
import { newOfferReceivingContext, newReceivingContext, restoreReceivingKeys, prepareDelivery, openDelivery, type Order } from "../src/commerce/protocol";
import { reference, storageService, deliveryRecord, type ChainRecord } from "../src/commerce/lifecycle";
import { ChainService } from "../../payunlock-backend/src/services/chain-service.js";
import { waitFinalized } from "../../payunlock-contract/scripts/finality.js";

if (!process.argv.includes("--send-test-transactions")) throw new Error("Explicit testnet flag required.");
let stage = "setup";
const root = new URL("../../output/reservation-v5/", import.meta.url);
async function main() {
  await mkdir(root, { recursive: true });
  const manifest = JSON.parse(await readFile(new URL("../../payunlock-contract/deployments/monad-testnet-payunlock-v5.json", import.meta.url), "utf8"));
  const abi = JSON.parse(await readFile(new URL("../../payunlock-contract/abi/PayUnlock.json", import.meta.url), "utf8")).abi;
  const provider = new JsonRpcProvider(process.env.MONAD_TESTNET_RPC_URL, 10143, { staticNetwork: true, cacheTimeout: -1 });
  const wallet = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY!, provider), c = new Contract(manifest.escrow, abi, wallet);
  const buyer = new Wallet(keccak256(new TextEncoder().encode("payunlock-v5-acceptance:" + process.env.MONAD_TESTNET_DEPLOYER_KEY!)), provider);
  const deployment = { chainId: 10143 as const, contract: manifest.escrow.toLowerCase() };
  type Report = { contract: string; offerId: string; buyerNonce: string; request: string; steps: Record<string, { hash: string; block: number }>; orderId?: string; endBlock?: number; passed?: boolean };
  const file = new URL("acceptance.json", root);
  let report: Report;
  try { report = JSON.parse(await readFile(file, "utf8")); }
  catch { report = { contract: manifest.escrow, offerId: crypto.randomUUID(), buyerNonce: hexlify(randomBytes(32)), request: hexlify(randomBytes(32)), steps: {} }; }
  assert.equal(report.contract, manifest.escrow);
  const save = () => writeFile(file, JSON.stringify(report, null, 2));
  await save();
  const send = async (name: string, method: string, args: unknown[], value = 0n) => {
    stage = name;
    if (report.steps[name]) { assert.equal((await waitFinalized(provider, report.steps[name].hash)).status, 1); return; }
    const target = name === "purchase" || name === "accept" ? c.connect(buyer) : c;
    const tx = await target.getFunction(method)(...args, { value });
    report.steps[name] = { hash: tx.hash, block: 0 }; await save();
    const receipt = await waitFinalized(provider, tx.hash); assert.equal(receipt.status, 1);
    report.steps[name].block = receipt.blockNumber; await save();
    console.log(JSON.stringify({ stage, hash: tx.hash, block: receipt.blockNumber }));
  };
  try {
    assert.equal((await provider.getNetwork()).chainId, 10143n);
    // Preserve the user-facing token choices on the fresh deployment.
    await send("enable-usdc", "setAllowedAsset", ["0x534b2f3a21130d7a60830c2df862319e593943a3", true]);
    if (!report.steps["fund-buyer"]) {
      stage = "fund-buyer";
      const tx = await wallet.sendTransaction({ to: buyer.address, value: parseEther("0.05") });
      report.steps["fund-buyer"] = { hash: tx.hash, block: 0 }; await save();
      const r = await waitFinalized(provider, tx.hash); assert.equal(r.status, 1);
      report.steps["fund-buyer"].block = r.blockNumber; await save();
    }
    const sellerContext = newOfferReceivingContext(deployment, wallet.address, report.offerId);
    const buyerContext = { ...newReceivingContext(deployment, buyer.address), nonce: report.buyerNonce };
    const sellerKeys = await restoreReceivingKeys(sellerContext, wallet, () => true), buyerKeys = await restoreReceivingKeys(buyerContext, buyer, () => true);
    try {
      const productKey = id(report.offerId), price = 1000000000n;
      const feeCapBps = await c.getFunction("serviceFeeBps")(), placementFee = await c.getFunction("offerPlacementFee")(), feeVersion = await c.getFunction("placementFeeVersion")();
      await send("create", "createProduct", [productKey, { token: ZeroAddress, price, hasEventEnd: false, eventEnd: 0, hasReviewOverride: false, reviewOverride: 0, commitmentWindow: 600 }, { nonce: sellerContext.nonce, publicKey: hexlify(sellerKeys.encryptionPublicKey) }, feeCapBps, placementFee, feeVersion], placementFee);
      await send("purchase", "purchase", [wallet.address, productKey, report.request, await c.getFunction("checkoutHash")(wallet.address, productKey), { nonce: buyerContext.nonce, publicKey: hexlify(buyerKeys.encryptionPublicKey) }], price);
      const orderId = String(await c.getFunction("orderForRequest")(buyer.address, report.request)); report.orderId = orderId; await save();
      let snapshot = await c.getFunction("getOrder")(orderId);
      const order: Order = { deployment, orderId, seller: { context: sellerContext, publicKey: encodeBase64(sellerKeys.encryptionPublicKey) }, buyer: { context: buyerContext, publicKey: encodeBase64(buyerKeys.encryptionPublicKey) }, terms: { version: 1, token: ZeroAddress, price: String(price), eventEnd: null, reviewWindow: String(snapshot.terms.reviewWindow), responseWindow: String(snapshot.terms.responseWindow) } };
      const service = storageService({ id: 1, apiOrigin: new URL(process.env.ZKBYTES_SERVICE_URL!).origin, downloadOrigin: new URL(process.env.ZKBYTES_DOWNLOAD_ORIGIN!).origin, maxRetentionSeconds: Number(process.env.ZKBYTES_MAX_RETENTION_SECONDS) });
      if (snapshot.state < 3n) {
        await send("reserve", "reserveDelivery", [orderId]);
        snapshot = await c.getFunction("getOrder")(orderId);
        assert.equal(snapshot.deliveryHash, ZeroHash);
        await assert.rejects(c.connect(buyer).getFunction("claimRefund").staticCall(orderId));
        await assert.rejects(c.getFunction("reserveDelivery").staticCall(orderId));
        stage = "reprepare-after-reservation";
        // No pre-reservation content survives or is necessary for TX2.
        const prepared = await prepareDelivery({ order, payload: { text: "Reservation-only TX1 live acceptance", tickets: [] }, signer: wallet, offerKeys: sellerKeys, service, latestPublicationSeconds: snapshot.publicationDeadline, isCurrent: () => true });
        const uploaded = await service.client.upload(prepared.item); assert.ok(!("state" in uploaded));
        const chain = new ChainService(process.env.MONAD_TESTNET_RPC_URL!);
        assert.equal((await chain.publication(orderId, report.steps.reserve!.hash, wallet.address.toLowerCase())).eligible, true);
        await assert.rejects(c.getFunction("publishDelivery").staticCall(orderId, { ...reference(prepared.record), contentHash: ZeroHash }));
        assert.equal((await c.getFunction("getOrder")(orderId)).publicationDeadline, snapshot.publicationDeadline);
        await send("publish", "publishDelivery", [orderId, reference(prepared.record)]);
      }
      stage = "independent-decryption";
      const raw = await c.getFunction("getRecord")(orderId, 0), hash = String(await c.getFunction("recordCommitments")(orderId, 0));
      const row: ChainRecord = { turn: "0", sender: wallet.address.toLowerCase(), commitment: hash, reference: { serviceId: Number(raw.serviceId), preparedAt: String(raw.preparedAt), creator: raw.creator, buyerEnvelope: raw.buyerEnvelope, sellerEnvelope: raw.sellerEnvelope, contentHash: raw.contentHash } };
      for (const role of ["buyer", "seller"] as const) {
        const keys = await restoreReceivingKeys(order[role].context, role === "buyer" ? buyer : wallet, () => true, order[role].publicKey);
        try { assert.equal((await openDelivery({ record: deliveryRecord(row, order), expectedRecordHash: hash, order, role, privateKey: keys.encryptionPrivateKey, services: [service], isCurrent: () => true })).payload.text, "Reservation-only TX1 live acceptance"); }
        finally { clearItemKeys(keys); }
      }
      await assert.rejects(c.getFunction("publishDelivery").staticCall(orderId, row.reference));
      await send("accept", "confirmReceipt", [orderId]);
      await send("payout", "withdrawSeller", [orderId]);
      report.passed = true; report.endBlock = report.steps.payout!.block; await save();
      console.log(JSON.stringify({ stage: "passed", contract: manifest.escrow, orderId, buyerAndSellerDecrypted: true, noDraftBackup: true }));
    } finally { clearItemKeys(sellerKeys); clearItemKeys(buyerKeys); }
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
