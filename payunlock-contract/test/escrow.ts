import { expect } from "chai";
import { network, artifacts } from "hardhat";
import { deploy, DeploymentResultType } from "@nomicfoundation/ignition-core";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keccak256, toUtf8Bytes, ZeroAddress, encodeBase64, hexlify, getBytes, type BaseContract } from "ethers";
import { deriveItemKeys, normalizeAndVerifyMasterSignature, prepareItem, sealSeed, openSealedSeed, decryptStorageItem, clearItemKeys } from "@zkbytes/sdk";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const PayUnlockFixture = buildModule("PayUnlockFixture", (m) => {
  const admin = m.getParameter<string>("admin");
  const codec = m.library("PayUnlockCodec");
  const arbitration = m.library("PayUnlockArbitration", { libraries: { PayUnlockCodec: codec } });
  const transfers = m.library("PayUnlockTransfers");
  const escrow = m.contract("PayUnlock", [admin, 86400, 60, 60, 86400], { libraries: { PayUnlockCodec: codec, PayUnlockArbitration: arbitration, PayUnlockTransfers: transfers } });
  const token = m.contract("TestPaymentToken", [admin]);
  const router = m.contract("PayUnlockAuthorizationRouter", [escrow]);
  const sender = { from: m.getAccount(0) };
  m.call(escrow, "setAuthorizationRouter", [router], sender);
  m.call(escrow, "setAllowedAsset", [token, true], sender);
  m.call(escrow, "setArbitrationFeeAsset", [token], sender);
  return { escrow, token, codec, arbitration, transfers, router };
});

const h = (s: string) => keccak256(toUtf8Bytes(s));
const receiving = (s: string) => ({ nonce: h(s), publicKey: h(`${s}:key`) });
const fn = (c: BaseContract, name: string) => c.getFunction(name);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
const terms = (overrides = {}) => ({ token: ZeroAddress, price: 1000n, hasEventEnd: false, eventEnd: 0n, hasReviewOverride: false, reviewOverride: 0n, commitmentWindow: 600, ...overrides });

async function setup() {
  const connection = await network.create();
  const { ethers, networkHelpers } = connection;
  const signers = await ethers.getSigners();
  if (signers.length < 6) throw new Error("Missing fixture accounts");
  const admin = signers[0]!, seller = signers[1]!, buyer = signers[2]!, other = signers[3]!, arbitrator = signers[4]!, replacement = signers[5]!;
  const deployed = await connection.ignition.deploy(PayUnlockFixture, { parameters: { PayUnlockFixture: { admin: admin.address } } });
  const escrow = deployed.escrow;
  const key = h("product");
  await fn(escrow.connect(seller), "createProduct")(key, terms(), receiving("seller"), 0, 0, 0);
  async function buy(overrides: { signer?: typeof buyer; request?: string; key?: string; value?: bigint } = {}) {
    const signer = overrides.signer ?? buyer, product = overrides.key ?? key;
    const request = overrides.request ?? h(`request:${await fn(escrow, "nextOrderId")()}`);
    const expected = await fn(escrow, "checkoutHash")(seller.address, product);
    const id = await fn(escrow, "nextOrderId")();
    await fn(escrow.connect(signer), "purchase")(seller.address, product, request, expected, receiving(signer.address), { value: overrides.value ?? 1000n });
    return id as bigint;
  }
  async function ref() {
    return { serviceId: 1, preparedAt: BigInt(await networkHelpers.time.latest()), creator: h("creator"), buyerEnvelope: "0x03" + "11".repeat(64), sellerEnvelope: "0x03" + "22".repeat(64), contentHash: h("private-content") };
  }
  async function committed(id: bigint) {
    const reference = await ref();
    await fn(escrow.connect(seller), "reserveDelivery")(id);
    return reference;
  }
  async function fulfill(id: bigint) { const reference = await committed(id); await fn(escrow.connect(seller), "publishDelivery")(id, reference); return reference; }
  return { connection, ethers, networkHelpers, admin, seller, buyer, other, arbitrator, replacement, escrow, token: deployed.token, codec: deployed.codec, key, buy, ref, committed, fulfill };
}

describe("PayUnlock escrow", function () {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeEach(async function () { f = await setup(); });
  afterEach(async function () { await f?.connection.close(); });


  it("bounds owner configuration and makes storage registration permanent", async function () {
    const { escrow: c, buyer } = f;
    for (const [name, args] of [["addStorageService", [2]], ["setBatchLimit", [1]], ["setTimingBounds", [60, 60, 600]]] as const) {
      await expect(fn(c.connect(buyer), name)(...args)).to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount");
    }
    await expect(fn(c, "deliveryRecordHash")(await f.buy(), { ...await f.ref(), serviceId: 0 })).to.be.revertedWithCustomError(c, "InvalidInput");
    for (const id of [0, 1]) await expect(fn(c, "addStorageService")(id)).to.be.revertedWithCustomError(c, "InvalidInput");
    await expect(fn(c, "addStorageService")(2)).to.emit(c, "StorageServiceAdded").withArgs(2);
    await expect(fn(c, "addStorageService")(2)).to.be.revertedWithCustomError(c, "InvalidInput");
    expect(await fn(c, "allowedStorageServices")(2)).to.equal(true);
    for (const n of [0, 31]) await expect(fn(c, "setBatchLimit")(n)).to.be.revertedWithCustomError(c, "InvalidInput");
    for (const args of [[0, 60, 600], [259201, 60, 600], [60, 0, 600], [60, 601, 600], [60, 60, 31536000]]) await expect(fn(c, "setTimingBounds")(...args)).to.be.revertedWithCustomError(c, "InvalidInput");
    await expect(fn(c, "setTimingBounds")(120, 10, 1000)).to.emit(c, "TimingBoundsChanged").withArgs(120, 10, 1000);
    await expect(fn(c, "setResponseWindow")(119)).to.be.revertedWithCustomError(c, "InvalidInput");
  });

  it("preserves purchased terms and committed records while new purchases enforce new bounds", async function () {
    const { escrow: c, seller, buyer, key, networkHelpers } = f;
    const a = await f.buy(), b = await f.buy(), r = await f.committed(a);
    const before = await fn(c, "getOrder")(a), hash = await fn(c, "deliveryRecordHash")(a, r);
    await fn(c, "setTimingBounds")(120, 10, 20);
    await fn(c, "setResponseWindow")(120); await fn(c, "setDefaultReviewWindow")(0);
    await fn(c, "addStorageService")(2); await fn(c, "setBatchLimit")(1);
    await expect(f.buy()).to.be.revertedWithCustomError(c, "InvalidInput");
    expect(await fn(c, "deliveryRecordHash")(a, r)).to.equal(hash);
    await fn(c.connect(seller), "publishDelivery")(a, r);
    let after = await fn(c, "getOrder")(a);
    expect(after.publicationDeadline).to.equal(before.publicationDeadline);
    expect(after.reviewDeadline).to.equal(BigInt(await networkHelpers.time.latest()) + 86400n);
    expect(after.terms).to.deep.equal(before.terms);
    await fn(c.connect(buyer), "openDispute")(a, await f.ref());
    after = await fn(c, "getOrder")(a);
    expect(after.responseDeadline).to.equal(BigInt(await networkHelpers.time.latest()) + 259200n);
    await fn(c.connect(seller), "refundDisputedOrder")(a); await fn(c.connect(buyer), "claimRefund")(b);
    await fn(c.connect(seller), "updateProduct")(key, terms({ commitmentWindow: 15 }), receiving("seller"));
    const fresh = await f.buy(); expect((await fn(c, "getOrder")(fresh)).terms.responseWindow).to.equal(120n);
  });

  it("routes additional services through delivery, negotiation, evidence and encrypted requests", async function () {
    const { escrow: c, seller, buyer, arbitrator } = f;
    const id = await f.buy(), r = { ...await f.ref(), serviceId: 2 };
    await expect(fn(c, "deliveryRecordHash")(id, r)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c, "addStorageService")(2);
    await fn(c.connect(seller), "reserveDelivery")(id);
    await fn(c.connect(seller), "publishDelivery")(id, r);
    const bad = { ...r, serviceId: 3 }, evidence = { contentRef: r, arbitratorEnvelope: r.buyerEnvelope }, badEvidence = { ...evidence, contentRef: bad };
    await expect(fn(c.connect(buyer), "openDispute")(id, bad)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(buyer), "openDispute")(id, r);
    await expect(fn(c.connect(seller), "replyToDispute")(id, 2, bad)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(seller), "replyToDispute")(id, 2, r);
    await fn(c, "configureArbitrator")(arbitrator.address, h("arb"), true);
    await fn(c.connect(arbitrator), "setMyArbitrationFee")(0, 0);
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 0, await fn(c, "arbitrationFeeAsset")(), badEvidence)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 0, await fn(c, "arbitrationFeeAsset")(), evidence);
    await expect(fn(c.connect(buyer), "submitArbitrationEvidence")(id, 1, badEvidence)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(buyer), "submitArbitrationEvidence")(id, 1, evidence);
    await expect(fn(c.connect(arbitrator), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 0, badEvidence)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(arbitrator), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 0, evidence);
    const commitment = await fn(c, "evidenceRequestCommitments")(id, 0);
    await fn(c, "setTimingBounds")(120, 1, 10); await fn(c, "setResponseWindow")(120);
    expect(await fn(c, "evidenceRequestCommitments")(id, 0)).to.equal(commitment);
    await fn(c.connect(arbitrator), "resolveArbitration")(id, 1, false);
  });

  it("splits a reduced batch without resetting deadlines or reassigning records", async function () {
    const { escrow: c, seller } = f;
    const ids = [await f.buy(), await f.buy()], refs = [await f.ref(), { ...await f.ref(), contentHash: h("second") }];
    const hashes = await Promise.all(ids.map((id, i) => fn(c, "deliveryRecordHash")(id, refs[i])));
    await fn(c, "setBatchLimit")(1);
    await expect(fn(c.connect(seller), "reserveDeliveries")(ids)).to.be.revertedWithCustomError(c, "InvalidInput");
    for (let i = 0; i < 2; i++) await fn(c.connect(seller), "reserveDeliveries")([ids[i]]);
    const deadlines = await Promise.all(ids.map(async id => (await fn(c, "getOrder")(id)).publicationDeadline));
    await expect(fn(c.connect(seller), "publishDeliveries")(ids, refs)).to.be.revertedWithCustomError(c, "InvalidInput");
    for (let i = 0; i < 2; i++) {
      await fn(c.connect(seller), "publishDeliveries")([ids[i]], [refs[i]]);
      expect((await fn(c, "getOrder")(ids[i])).publicationDeadline).to.equal(deadlines[i]);
      expect(await fn(c, "recordCommitments")(ids[i], 0)).to.equal(hashes[i]);
    }
  });

  it("enforces namespaces, existence, terminal cancellation and asset snapshots", async function () {
    const { escrow: c, seller, buyer, key, buy, token } = f;
    await expect(fn(c, "getOrder")(0)).to.be.revertedWithCustomError(c, "NotFound");
    await expect(fn(c.connect(buyer), "updateProduct")(key, terms(), receiving("x"))).to.be.revertedWithCustomError(c, "NotFound");
    await expect(fn(c.connect(seller), "createProduct")(key, terms(), receiving("seller"), 0, 0, 0)).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(buyer), "createProduct")(key, terms(), receiving("other-seller"), 0, 0, 0);
    const id = await buy();
    await expect(fn(c.connect(seller), "updateProduct")(key, terms({ token: await token.getAddress() }), receiving("seller"))).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(seller), "updateProduct")(key, terms({ price: 2000n }), receiving("new-key"));
    expect((await fn(c, "getOrder")(id)).terms.price).to.equal(1000n);
    await fn(c.connect(seller), "cancelProduct")(key);
    await expect(fn(c.connect(seller), "setSalesDisabled")(key, false)).to.be.revertedWithCustomError(c, "InvalidState");
    await expect(buy()).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(buyer), "claimRefund")(id);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(0n);
  });

  it("consumes request IDs atomically and permanently, scoped to buyers", async function () {
    const { escrow: c, seller, buyer, other, key, buy } = f;
    const request = h("fixed-request"), expected = await fn(c, "checkoutHash")(seller.address, key);
    await expect(fn(c.connect(buyer), "purchase")(seller.address, key, request, expected, receiving("buyer"), { value: 999n })).to.be.revertedWithCustomError(c, "InexactTransfer");
    expect(await fn(c, "orderForRequest")(buyer.address, request)).to.equal(0n);
    const id = await buy({ request });
    await expect(buy({ request })).to.be.revertedWithCustomError(c, "DuplicateRequest");
    await fn(c.connect(buyer), "claimRefund")(id);
    await expect(buy({ request })).to.be.revertedWithCustomError(c, "DuplicateRequest");
    await buy({ signer: other, request });
    await buy();
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(2000n);
  });

  it("rejects stale terms, seller keys and default changes; disabled sales can resume", async function () {
    const { escrow: c, seller, buyer, key } = f;
    const expected = await fn(c, "checkoutHash")(seller.address, key);
    await fn(c, "setDefaultReviewWindow")(0);
    await expect(fn(c.connect(buyer), "purchase")(seller.address, key, h("r"), expected, receiving("buyer"), { value: 1000n })).to.be.revertedWithCustomError(c, "StaleTerms");
    await fn(c, "setDefaultReviewWindow")(86400);
    await fn(c.connect(seller), "setSalesDisabled")(key, true);
    await expect(f.buy()).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(seller), "setSalesDisabled")(key, false);
    const id = await f.buy();
    await fn(c, "setResponseWindow")(120);
    expect((await fn(c, "getOrder")(id)).terms.responseWindow).to.equal(259200n);
    await expect(fn(c.connect(buyer), "setResponseWindow")(120)).to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount");
    for (const value of [0, 59]) await expect(fn(c, "setResponseWindow")(value)).to.be.revertedWithCustomError(c, "InvalidInput");
    await expect(fn(c, "setDefaultReviewWindow")(2n ** 64n - 1n)).to.be.revertedWithCustomError(c, "InvalidInput");
  });

  it("matches the Phase 2 canonical complete-record hash byte-for-byte", async function () {
    const { escrow: c, buy, ref, seller, buyer, ethers } = f;
    const id = await buy(), r = await ref(), o = await fn(c, "getOrder")(id);
    const deployment = { chainId: Number((await ethers.provider.getNetwork()).chainId), contract: (await c.getAddress()).toLowerCase() };
    const recipient = (account: string, identity: ReturnType<typeof receiving>) => ({ context: { version: 1, deployment, account: account.toLowerCase(), nonce: identity.nonce }, publicKey: encodeBase64(identity.publicKey) });
    const order = { deployment, orderId: id.toString(), buyer: recipient(buyer.address, receiving(buyer.address)), seller: recipient(seller.address, receiving("seller")), terms: { version: 1, token: ZeroAddress, price: "1000", eventEnd: null, reviewWindow: "86400", responseWindow: "259200" } };
    const record = { version: 2, order, kind: "delivery", sender: seller.address.toLowerCase(), turn: "0", serviceId: r.serviceId, profile: "zkbytes-wallet-eip191-hkdfsha256-ed25519-x25519-hpke-v1", preparedAt: new Date(Number(r.preparedAt) * 1000).toISOString(), expiresAt: new Date((Number(r.preparedAt) + 31536000) * 1000).toISOString().replace(".000Z", "Z"), creator: { publicKey: encodeBase64(r.creator), signatureScheme: "zkbytes-ed25519-v1" }, buyerEnvelope: encodeBase64(r.buyerEnvelope), sellerEnvelope: encodeBase64(r.sellerEnvelope), contentHash: r.contentHash };
    expect(o.sellerReceiving.publicKey).to.equal(receiving("seller").publicKey);
    expect(await fn(c, "deliveryRecordHash")(id, r)).to.equal(h("payunlock-record-v2\n" + canonical(record)));
  });

  it("publishes a real SDK delivery and restores both parties from authenticated chain contexts", async function () {
    const { escrow: c, seller, buyer, key, ethers, networkHelpers } = f;
    const deployment = { chainId: Number((await ethers.provider.getNetwork()).chainId), contract: (await c.getAddress()).toLowerCase() };
    async function identity(signer: typeof seller) {
      const context = { version: 1, deployment, account: signer.address.toLowerCase(), nonce: h(signer.address) };
      const message = `PayUnlock receiving identity v1\n${canonical(context)}\nRestore my encryption key. No transaction is requested.`;
      const signature = normalizeAndVerifyMasterSignature(await signer.signMessage(message), message, signer.address);
      try { return { context, keys: await deriveItemKeys(signature) }; } finally { signature.fill(0); }
    }
    const sellerIdentity = await identity(seller), buyerIdentity = await identity(buyer);
    const wire = (value: typeof sellerIdentity) => ({ nonce: value.context.nonce, publicKey: hexlify(value.keys.encryptionPublicKey) });
    await fn(c.connect(seller), "updateProduct")(key, terms(), wire(sellerIdentity));
    await fn(c.connect(buyer), "purchase")(seller.address, key, h("sdk-request"), await fn(c, "checkoutHash")(seller.address, key), wire(buyerIdentity), { value: 1000n });
    const id = await fn(c, "orderForRequest")(buyer.address, h("sdk-request"));
    const order = { deployment, orderId: id.toString(), buyer: { context: buyerIdentity.context, publicKey: encodeBase64(buyerIdentity.keys.encryptionPublicKey) }, seller: { context: sellerIdentity.context, publicKey: encodeBase64(sellerIdentity.keys.encryptionPublicKey) }, terms: { version: 1, token: ZeroAddress, price: "1000", eventEnd: null, reviewWindow: "86400", responseWindow: "259200" } };
    const opening = { version: 1, order, kind: "delivery", sender: seller.address.toLowerCase(), turn: "0", salt: h("synthetic-test-salt"), payload: { text: "Synthetic purchased content", tickets: [{ row: "0", ticket: "test-ticket" }] } };
    const now = await networkHelpers.time.latest(), expiresAt = new Date((now + 31536000) * 1000).toISOString().replace(".000Z", "Z");
    const prepared = await prepareItem({ plaintext: canonical(opening), expiresAt, managers: [], recipientPublicKeys: [order.buyer.publicKey, order.seller.publicKey], signer: seller });
    try {
      const r = { serviceId: 1, preparedAt: now, creator: hexlify(Buffer.from(prepared.item.creator.publicKey, "base64")), buyerEnvelope: hexlify(await sealSeed(prepared.item.seed, order.buyer.publicKey)), sellerEnvelope: hexlify(await sealSeed(prepared.item.seed, order.seller.publicKey)), contentHash: h("payunlock-content-v1\n" + canonical(opening)) };
      const record = { version: 2, order, kind: "delivery", sender: seller.address.toLowerCase(), turn: "0", serviceId: r.serviceId, profile: prepared.item.keyDerivationProfile, preparedAt: new Date(now * 1000).toISOString(), expiresAt, creator: prepared.item.creator, buyerEnvelope: encodeBase64(r.buyerEnvelope), sellerEnvelope: encodeBase64(r.sellerEnvelope), contentHash: r.contentHash };
      const commitment = h("payunlock-record-v2\n" + canonical(record));
      expect(await fn(c, "deliveryRecordHash")(id, r)).to.equal(commitment);
      await fn(c.connect(seller), "reserveDelivery")(id);
      await fn(c.connect(seller), "publishDelivery")(id, r);
      clearItemKeys(buyerIdentity.keys); clearItemKeys(sellerIdentity.keys);
      const stored = await fn(c, "getRecord")(id, 0);
      for (const signer of [buyer, seller]) {
        const recovered = await identity(signer);
        try {
          const envelope = signer === buyer ? stored.buyerEnvelope : stored.sellerEnvelope;
          expect(await openSealedSeed(getBytes(envelope), recovered.keys.encryptionPrivateKey)).to.equal(prepared.item.seed);
          const opened = await decryptStorageItem(prepared.item, prepared.item.creator, recovered.keys.encryptionPrivateKey);
          expect(h("payunlock-content-v1\n" + opened.plaintext)).to.equal(stored.contentHash);
          expect(JSON.parse(opened.plaintext).payload.text).to.equal(opening.payload.text);
        } finally { clearItemKeys(recovered.keys); }
      }
    } finally { clearItemKeys(prepared.keys); clearItemKeys(buyerIdentity.keys); clearItemKeys(sellerIdentity.keys); }
  });

  it("resumes an incomplete Ignition deployment and reruns without redeployment", async function () {
    const connection = await network.create();
    try {
      const [admin] = await connection.ethers.getSigners();
      if (!admin) throw new Error("Missing admin");
      const partial = buildModule("PayUnlockFixture", m => ({ codec: m.library("PayUnlockCodec") }));
      const root = resolve("../output/phase-3-ignition");
      await mkdir(root, { recursive: true });
      const deploymentDir = await mkdtemp(resolve(root, "recovery-"));
      const options = { deploymentDir, artifactResolver: { loadArtifact: (name: string) => artifacts.readArtifact(name), getBuildInfo: async () => undefined }, provider: connection.provider, accounts: [admin.address], config: { requiredConfirmations: 1 } };
      const first = await deploy({ ...options, ignitionModule: partial, deploymentParameters: {} });
      if (first.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) throw new Error("Partial deployment failed");
      const parameters = { PayUnlockFixture: { admin: admin.address } };
      const resumed = await deploy({ ...options, ignitionModule: PayUnlockFixture, deploymentParameters: parameters });
      if (resumed.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) throw new Error("Resume failed");
      expect(resumed.contracts.codec?.address).to.equal(first.contracts.codec?.address);
      const before = await connection.ethers.provider.getTransactionCount(admin.address);
      const again = await deploy({ ...options, ignitionModule: PayUnlockFixture, deploymentParameters: parameters });
      if (again.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) throw new Error("Rerun failed");
      expect(again.contracts.escrow?.address).to.equal(resumed.contracts.escrow?.address);
      expect(await connection.ethers.provider.getTransactionCount(admin.address)).to.equal(before);
    } finally { await connection.close(); }
  });

  it("reserves once, retries failed TX2 with new content, and pays once after explicit acceptance", async function () {
    const { escrow: c, seller, buyer, buy, committed } = f;
    const id = await buy(), r = await committed(id);
    await expect(fn(c.connect(buyer), "claimRefund")(id)).to.be.revertedWithCustomError(c, "InvalidState");
    await expect(fn(c.connect(seller), "reserveDelivery")(id)).to.be.revertedWithCustomError(c, "InvalidState");
    const reserved = await fn(c, "getOrder")(id);
    expect(reserved.deliveryHash).to.equal(`0x${"00".repeat(32)}`);
    await expect(fn(c.connect(buyer), "publishDelivery")(id, r)).to.be.revertedWithCustomError(c, "Unauthorized");
    await expect(fn(c.connect(seller), "publishDelivery")(id, { ...r, contentHash: `0x${"00".repeat(32)}` })).to.be.revert(f.ethers);
    expect((await fn(c, "getOrder")(id)).publicationDeadline).to.equal(reserved.publicationDeadline);
    r.contentHash = h("reprepared after losing the first page");
    await fn(c.connect(seller), "publishDelivery")(id, r);
    await expect(fn(c.connect(seller), "withdrawSeller")(id)).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(buyer), "confirmReceipt")(id);
    await fn(c.connect(seller), "withdrawSeller")(id);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(0n);
    await expect(fn(c.connect(seller), "withdrawSeller")(id)).to.be.revertedWithCustomError(c, "InvalidState");
    await expect(fn(c.connect(buyer), "claimRefund")(id)).to.be.revertedWithCustomError(c, "InvalidState");
  });

  for (const offset of [-1, 0, 1]) it(`enforces publication deadline at offset ${offset}`, async function () {
    const { escrow: c, seller, buyer, buy, committed, networkHelpers } = f;
    const id = await buy(), r = await committed(id), o = await fn(c, "getOrder")(id);
    await networkHelpers.time.setNextBlockTimestamp(o.publicationDeadline + BigInt(offset));
    if (offset < 0) await fn(c.connect(seller), "publishDelivery")(id, r);
    else {
      await expect(fn(c.connect(seller), "publishDelivery")(id, r)).to.be.revertedWithCustomError(c, "Deadline");
      await expect(fn(c.connect(seller), "reserveDelivery")(id)).to.be.revertedWithCustomError(c, "InvalidState");
      await fn(c.connect(buyer), "claimRefund")(id);
    }
  });

  it("cancellation invalidates only unpublished commitments and keeps published rights", async function () {
    const { escrow: c, seller, buyer, key, buy, committed, fulfill, ref } = f;
    const first = await buy(), second = await buy(), third = await buy();
    const r = await committed(first); await fulfill(second);
    await fn(c.connect(seller), "cancelProduct")(key);
    await expect(fn(c.connect(seller), "publishDelivery")(first, r)).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(buyer), "claimRefund")(first);
    await fn(c.connect(seller), "refundCanceledOrders")([third]);
    await fn(c.connect(buyer), "openDispute")(second, await ref());
    await expect(fn(c.connect(seller), "refundCanceledOrders")([second])).to.be.revertedWithCustomError(c, "InvalidState");
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(1000n);
  });

  for (const hasEventEnd of [false, true]) for (const hasReviewOverride of [false, true]) it(`snapshots optional terms event=${hasEventEnd}, override=${hasReviewOverride}`, async function () {
    const { escrow: c, seller, buyer, key, buy, fulfill, networkHelpers } = f;
    const end = BigInt(await networkHelpers.time.latest()) + 1000n;
    await fn(c.connect(seller), "updateProduct")(key, terms({ hasEventEnd, eventEnd: hasEventEnd ? end : 0n, hasReviewOverride, reviewOverride: 0n }), receiving("seller"));
    const id = await buy();
    await fn(c, "setDefaultReviewWindow")(5);
    await fulfill(id);
    const o = await fn(c, "getOrder")(id);
    expect(o.terms.reviewWindow).to.equal(hasReviewOverride ? 0n : 86400n);
    const now = BigInt(await networkHelpers.time.latest());
    expect(o.reviewDeadline).to.equal((hasEventEnd ? end : now) + (hasReviewOverride ? 0n : 86400n));
    if (o.reviewDeadline > now) await networkHelpers.time.setNextBlockTimestamp(o.reviewDeadline);
    await expect(fn(c.connect(buyer), "openDispute")(id, await f.ref())).to.be.revertedWithCustomError(c, "Deadline");
    await fn(c.connect(seller), "withdrawSeller")(id);
  });

  it("alternates messages and preserves both earned timeout rights at equality", async function () {
    const { escrow: c, seller, buyer, buy, fulfill, ref, networkHelpers } = f;
    await fn(c, "setResponseWindow")(60);
    const id = await buy(); await fulfill(id);
    await fn(c.connect(buyer), "openDispute")(id, await ref());
    await expect(fn(c.connect(buyer), "replyToDispute")(id, 2, await ref())).to.be.revertedWithCustomError(c, "Unauthorized");
    await expect(fn(c.connect(seller), "withdrawSeller")(id)).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(seller), "replyToDispute")(id, 2, await ref());
    let o = await fn(c, "getOrder")(id);
    expect(o.turn).to.equal(2n);
    await networkHelpers.time.setNextBlockTimestamp(o.responseDeadline);
    await expect(fn(c.connect(buyer), "replyToDispute")(id, 2, await ref())).to.be.revertedWithCustomError(c, "Deadline");
    await expect(fn(c.connect(seller), "refundDisputedOrder")(id)).to.be.revertedWithCustomError(c, "Deadline");
    await fn(c.connect(seller), "claimResponseTimeout")(id);
    const id2 = await buy(); await fulfill(id2);
    await fn(c.connect(buyer), "openDispute")(id2, await ref());
    o = await fn(c, "getOrder")(id2);
    await networkHelpers.time.setNextBlockTimestamp(o.responseDeadline);
    await expect(fn(c.connect(buyer), "confirmReceipt")(id2)).to.be.revertedWithCustomError(c, "Deadline");
    await fn(c.connect(buyer), "claimResponseTimeout")(id2);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(0n);
  });

  it("settles ERC-20 exactly and preserves rights after allowlist removal", async function () {
    const { escrow: c, token, seller, buyer, key, buy } = f;
    await fn(c.connect(seller), "updateProduct")(key, terms({ token: await token.getAddress() }), receiving("seller"));
    await fn(token, "transfer")(buyer.address, 2000n);
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 2000n);
    const request = h("erc-request"), id = await buy({ value: 0n, request });
    await expect(buy({ value: 0n, request })).to.be.revertedWithCustomError(c, "DuplicateRequest");
    await fn(c, "setAllowedAsset")(await token.getAddress(), false);
    await expect(buy({ value: 0n })).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(buyer), "claimRefund")(id);
    expect(await fn(token, "balanceOf")(buyer.address)).to.equal(2000n);
    expect(await fn(c, "liabilities")(await token.getAddress())).to.equal(0n);
  });

  it("rolls back atomic batches without extending commitments", async function () {
    const { escrow: c, seller, buyer, buy } = f;
    const a = await buy(), b = await buy();
    await fn(c.connect(buyer), "claimRefund")(b);
    await expect(fn(c.connect(seller), "reserveDeliveries")([a, b])).to.be.revertedWithCustomError(c, "InvalidState");
    expect((await fn(c, "getOrder")(a)).state).to.equal(1n);
    await expect(fn(c.connect(seller), "reserveDeliveries")([])).to.be.revertedWithCustomError(c, "InvalidInput");
    await expect(fn(c.connect(seller), "reserveDeliveries")(Array(31).fill(a))).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(seller), "reserveDelivery")(a);
  });

  it("rejects a nested ERC-20 purchase and consumes only the original request", async function () {
    const { escrow: c, seller, buyer, key, ethers } = f;
    const token = await ethers.deployContract("InexactToken", [buyer.address]), asset = await token.getAddress();
    await fn(c, "setAllowedAsset")(asset, true);
    await fn(c.connect(seller), "updateProduct")(key, terms({ token: asset }), receiving("seller"));
    const nested = h("nested");
    await fn(token, "setCallback")(await c.getAddress(), c.interface.encodeFunctionData("purchase", [seller.address, key, nested, await fn(c, "checkoutHash")(seller.address, key), receiving("malicious-token")]));
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 1000n);
    await f.buy({ value: 0n });
    expect(await fn(token, "reentered")()).to.equal(false);
    expect(await fn(c, "orderForRequest")(asset, nested)).to.equal(0n);
    expect(await fn(c, "nextOrderId")()).to.equal(2n);
  });

  it("keeps a same-ID pair of competing submissions to one deposit", async function () {
    const request = h("competing-request");
    const results = await Promise.allSettled([f.buy({ request }), f.buy({ request })]);
    expect(results.filter(r => r.status === "fulfilled").length).to.equal(1);
    expect(await fn(f.escrow, "liabilities")(ZeroAddress)).to.equal(1000n);
    expect(await fn(f.escrow, "nextOrderId")()).to.equal(2n);
  });

  it("supports a 30-order publication batch within the Monad transaction gas limit", async function () {
    const { escrow: c, seller, key, networkHelpers } = f;
    // Large price/response fields and a future event exercise long canonical JSON.
    const price = 2n ** 250n;
    await networkHelpers.setBalance(f.buyer.address, 2n ** 255n);
    await fn(c, "setResponseWindow")(2n ** 64n - 1n - BigInt(await networkHelpers.time.latest()) - 10000n);
    await fn(c.connect(seller), "updateProduct")(key, terms({ price, hasEventEnd: true, eventEnd: BigInt(await networkHelpers.time.latest()) + 86400n }), receiving("seller"));
    const ids: bigint[] = [], references = [], commitments = [];
    for (let i = 0; i < 30; ++i) {
      const id = await f.buy({ value: price }), r = await f.ref(); ids.push(id); references.push(r);
      commitments.push(await fn(c, "deliveryRecordHash")(id, r));
    }
    const commitGas = await fn(c.connect(seller), "reserveDeliveries").estimateGas(ids);
    await fn(c.connect(seller), "reserveDeliveries")(ids);
    const gas = await fn(c.connect(seller), "publishDeliveries").estimateGas(ids, references);
    expect(gas * 12n / 10n).to.be.lessThan(30000000n);
    await mkdir(resolve("../output/phase-6.6"), { recursive: true });
    await writeFile(resolve("../output/phase-6.6/batch-gas.json"), JSON.stringify({ ceiling: 30, commitGas: String(commitGas), publishGas: String(gas), budget: 30000000, marginPercent: 20 }, null, 2));
    await fn(c.connect(seller), "publishDeliveries")(ids, references);
    for (const id of ids) expect((await fn(c, "getOrder")(id)).state).to.equal(3n);
  });

  it("gas-tests canceled committed token refunds to 30 distinct recipients", async function () {
    const { escrow: c, seller, token, networkHelpers, ethers } = f;
    const key = h("ceiling-token"), asset = await token.getAddress();
    await fn(c.connect(seller), "createProduct")(key, terms({ token: asset }), receiving("seller"), 0, 0, 0);
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const address = h(`gas-buyer-${i}`).slice(0, 42);
      await networkHelpers.setBalance(address, 10n ** 18n);
      await networkHelpers.impersonateAccount(address);
      const signer = await ethers.getSigner(address);
      await fn(token, "transfer")(address, 1000n);
      await fn(token.connect(signer), "approve")(await c.getAddress(), 1000n);
      ids.push(await f.buy({ signer, key, value: 0n }));
    }
    await fn(c.connect(seller), "reserveDeliveries")(ids);
    await fn(c.connect(seller), "cancelProduct")(key);
    const gas = await fn(c.connect(seller), "refundCanceledOrders").estimateGas(ids);
    expect(gas * 12n / 10n).to.be.lessThan(30000000n);
    await fn(c.connect(seller), "refundCanceledOrders")(ids);
    for (const id of ids) expect((await fn(c, "getOrder")(id)).state).to.equal(9n);
    const file = resolve("../output/phase-6.6/batch-gas.json");
    const report = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...report, canceledTokenRefundGas: String(gas) }, null, 2));
  });

  it("handles past events and a zero platform default without an implicit review interval", async function () {
    const { escrow: c, seller, buyer, key, networkHelpers } = f;
    await fn(c, "setDefaultReviewWindow")(0);
    const past = BigInt(await networkHelpers.time.latest()) - 100n;
    await fn(c.connect(seller), "updateProduct")(key, terms({ hasEventEnd: true, eventEnd: past }), receiving("seller"));
    const id = await f.buy(); await f.fulfill(id);
    expect((await fn(c, "getOrder")(id)).reviewDeadline).to.equal(BigInt(await networkHelpers.time.latest()));
    await expect(fn(c.connect(buyer), "openDispute")(id, await f.ref())).to.be.revertedWithCustomError(c, "Deadline");
    await fn(c.connect(seller), "withdrawSeller")(id);
  });

  for (const offset of [-1, 0, 1]) it(`preserves negotiation deadline at offset ${offset}`, async function () {
    const { escrow: c, seller, buyer, networkHelpers } = f;
    await fn(c, "setResponseWindow")(60);
    const id = await f.buy(); await f.fulfill(id);
    await fn(c.connect(buyer), "openDispute")(id, await f.ref());
    const o = await fn(c, "getOrder")(id), r = await f.ref();
    await networkHelpers.time.setNextBlockTimestamp(o.responseDeadline + BigInt(offset));
    if (offset < 0) {
      await fn(c.connect(seller), "replyToDispute")(id, 2, r);
      expect((await fn(c, "getOrder")(id)).responseDeadline).to.equal(o.responseDeadline - 1n + 60n);
    } else {
      await expect(fn(c.connect(seller), "replyToDispute")(id, 2, r)).to.be.revertedWithCustomError(c, "Deadline");
      await fn(c.connect(buyer), "claimResponseTimeout")(id);
    }
  });

  it("rejects unsupported assets, invalid durations, expiry and malformed envelopes", async function () {
    const { escrow: c, seller, key, buyer } = f;
    for (const invalid of [{ commitmentWindow: 59 }, { commitmentWindow: 86401 }, { price: 0n }, { token: buyer.address }, { eventEnd: 1n }, { hasEventEnd: true, eventEnd: 2n ** 64n - 1n }]) {
      await expect(fn(c.connect(seller), "updateProduct")(key, terms(invalid), receiving("seller"))).to.be.revertedWithCustomError(c, "InvalidInput");
    }
    await fn(c.connect(seller), "updateProduct")(key, terms({ hasReviewOverride: true, reviewOverride: 31536000n }), receiving("seller"));
    await expect(f.buy()).to.be.revertedWithCustomError(c, "InvalidInput");
    await fn(c.connect(seller), "updateProduct")(key, terms(), receiving("seller"));
    const id = await f.buy(), r = await f.ref();
    for (const invalid of [{ buyerEnvelope: "0x" }, { sellerEnvelope: "0x02" + "11".repeat(64) }, { preparedAt: r.preparedAt - 31536001n }]) {
      await expect(fn(c, "deliveryRecordHash")(id, { ...r, ...invalid })).to.be.revertedWithCustomError(f.codec, "InvalidReference");
    }
  });

  async function arbitrationFixture() {
    const { escrow: c, buyer, seller, arbitrator, replacement, token } = f;
    await fn(c, "configureArbitrator")(arbitrator.address, h("arb-key"), true);
    await fn(c, "configureArbitrator")(replacement.address, h("replacement-key"), true);
    await fn(c.connect(arbitrator), "setMyArbitrationFee")(0, 100n);
    await fn(c.connect(replacement), "setMyArbitrationFee")(0, 500n);
    await fn(token, "transfer")(buyer.address, 1000n);
    await fn(token, "transfer")(seller.address, 1000n);
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 1000n);
    await fn(token.connect(seller), "approve")(await c.getAddress(), 1000n);
    const id = await f.buy(); await f.fulfill(id);
    await fn(c.connect(buyer), "openDispute")(id, await f.ref());
    const evidence = { contentRef: await f.ref(), arbitratorEnvelope: "0x03" + "33".repeat(64) };
    return { id, evidence };
  }

  it("activates one paid case atomically and disables ordinary/voluntary settlement", async function () {
    const { escrow: c, buyer, seller, arbitrator, ethers } = f;
    const { id, evidence } = await arbitrationFixture();
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, ZeroAddress, evidence)).to.be.revertedWithCustomError(c, "InvalidState");
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 0, 100n, await fn(c, "arbitrationFeeAsset")(), evidence)).to.be.revertedWithCustomError(c, "StaleTerms");
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 99n, await fn(c, "arbitrationFeeAsset")(), evidence)).to.be.revertedWithCustomError(c, "StaleTerms");
    const before = await fn(f.token, "balanceOf")(arbitrator.address);
    await fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence);
    expect(await fn(f.token, "balanceOf")(arbitrator.address)).to.equal(before + 100n);
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(1000n);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(1000n);
    for (const [actor, method] of [[buyer, "confirmReceipt"], [seller, "refundDisputedOrder"], [seller, "withdrawSeller"], [buyer, "claimResponseTimeout"]] as const) {
      await expect(fn(c.connect(actor), method)(id)).to.be.revertedWithCustomError(c, "InvalidState");
    }
    await expect(fn(c.connect(seller), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence)).to.be.revertedWithCustomError(c, "InvalidState");
    await fn(c.connect(arbitrator), "resolveArbitration")(id, 1, true);
    expect((await fn(c, "getOrder")(id)).state).to.equal(8n);
    await expect(fn(c.connect(arbitrator), "resolveArbitration")(id, 1, false)).to.be.revertedWithCustomError(c, "InvalidState");
  });

  it("pins keys and revisions, preserves fees on replacement, and permits decisions without handover", async function () {
    const { escrow: c, buyer, arbitrator, replacement, other } = f;
    const { id, evidence } = await arbitrationFixture();
    await fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence);
    await fn(c, "configureArbitrator")(arbitrator.address, h("rotated-key"), false);
    expect((await fn(c, "getAssignment")(id)).publicKey).to.equal(h("arb-key"));
    await fn(c.connect(arbitrator), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 2n ** 64n - 1n, evidence);
    await expect(fn(c.connect(other), "replaceArbitrator")(id, 1, replacement.address, 1, h("reason"))).to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount");
    await fn(c, "replaceArbitrator")(id, 1, replacement.address, 1, h("reason"));
    const a = await fn(c, "getAssignment")(id);
    expect(a.fee).to.equal(100n); expect(a.revision).to.equal(2n); expect(a.handoverRecorded).to.equal(false);
    expect(await fn(c, "evidenceRequestCount")(id)).to.equal(1n);
    await expect(fn(c.connect(arbitrator), "resolveArbitration")(id, 1, true)).to.be.revertedWithCustomError(c, "StaleTerms");
    await expect(fn(c.connect(arbitrator), "resolveArbitration")(id, 2, true)).to.be.revertedWithCustomError(c, "Unauthorized");
    await expect(fn(c.connect(buyer), "submitArbitrationEvidence")(id, 1, evidence)).to.be.revertedWithCustomError(c, "StaleTerms");
    await fn(c.connect(replacement), "resolveArbitration")(id, 2, false);
    expect((await fn(c, "getOrder")(id)).state).to.equal(9n);
    await expect(fn(c, "replaceArbitrator")(id, 2, arbitrator.address, 2, h("again"))).to.be.revertedWithCustomError(c, "InvalidState");
  });

  it("accepts private supplemental evidence and rejects unauthorized or replayed requests", async function () {
    const { escrow: c, buyer, seller, arbitrator, replacement } = f;
    const { id, evidence } = await arbitrationFixture();
    await fn(c.connect(seller), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence);
    await expect(fn(c.connect(buyer), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 0, evidence)).to.be.revertedWithCustomError(c, "Unauthorized");
    await fn(c.connect(arbitrator), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 0, evidence);
    expect(await fn(c, "evidenceRequestCommitments")(id, 0)).not.to.equal(h(""));
    await expect(fn(c.connect(arbitrator), "requestArbitrationEvidence")(id, 1, 0, buyer.address, 0, evidence)).to.be.revertedWithCustomError(c, "StaleTerms");
    await fn(c.connect(buyer), "submitArbitrationEvidence")(id, 1, evidence);
    await fn(c, "replaceArbitrator")(id, 1, replacement.address, 1, h("replacement"));
    await fn(c.connect(seller), "submitArbitrationEvidence")(id, 2, evidence);
    expect((await fn(c, "getAssignment")(id)).handoverRecorded).to.equal(true);
    expect(await fn(c, "evidenceCount")(id)).to.equal(3n);
    await fn(c.connect(replacement), "resolveArbitration")(id, 2, true);
  });

  it("rejects arbitration at an earned timeout and stale queued replies", async function () {
    const { escrow: c, buyer, seller, arbitrator, networkHelpers } = f;
    const { id, evidence } = await arbitrationFixture();
    await fn(c.connect(seller), "replyToDispute")(id, 2, await f.ref());
    await fn(c.connect(buyer), "replyToDispute")(id, 3, await f.ref());
    await expect(fn(c.connect(seller), "replyToDispute")(id, 2, await f.ref())).to.be.revertedWithCustomError(c, "StaleTerms");
    const o = await fn(c, "getOrder")(id);
    await networkHelpers.time.setNextBlockTimestamp(o.responseDeadline);
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence)).to.be.revertedWithCustomError(c, "Deadline");
    await fn(c.connect(buyer), "claimResponseTimeout")(id);
  });

  it("rolls back a failing arbitration fee transfer with no activated case", async function () {
    const { escrow: c, buyer, arbitrator, token } = f;
    const { id, evidence } = await arbitrationFixture();
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 0);
    await expect(fn(c.connect(buyer), "requestArbitration")(id, arbitrator.address, 1, 1, 100n, await fn(c, "arbitrationFeeAsset")(), evidence)).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    expect((await fn(c, "getOrder")(id)).state).to.equal(4n);
    expect(await fn(c, "evidenceCount")(id)).to.equal(0n);
    await expect(fn(c, "getAssignment")(id)).to.be.revertedWithCustomError(c, "NotFound");
    expect(await fn(token, "balanceOf")(arbitrator.address)).to.equal(0n);
  });

  it("handles rejecting recipients and reentrancy without losing liabilities", async function () {
    const { escrow: c, seller, key, ethers } = f;
    const actor = await ethers.deployContract("AdversarialRecipient"), address = await actor.getAddress(), target = await c.getAddress();
    const call = (method: string, args: unknown[]) => c.interface.encodeFunctionData(method, args);
    await fn(actor, "execute")(target, call("purchase", [seller.address, key, h("actor"), await fn(c, "checkoutHash")(seller.address, key), receiving("actor")]), { value: 1000n });
    const id = await fn(c, "orderForRequest")(address, h("actor"));
    await fn(actor, "configure")(true, ZeroAddress, "0x");
    await expect(fn(actor, "execute")(target, call("claimRefund", [id]))).to.be.revertedWithCustomError(c, "TransferFailed");
    expect((await fn(c, "getOrder")(id)).state).to.equal(1n);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(1000n);
    await fn(actor, "configure")(false, target, call("claimRefund", [id]));
    await fn(actor, "execute")(target, call("claimRefund", [id]));
    expect(await fn(actor, "reentered")()).to.equal(false);
    expect(await ethers.provider.getBalance(address)).to.equal(1000n);
    expect(await fn(c, "liabilities")(ZeroAddress)).to.equal(0n);
  });

  it("rejects fee-on-transfer deposits and outgoing transfers atomically", async function () {
    const { escrow: c, seller, buyer, key, ethers } = f;
    const token = await ethers.deployContract("InexactToken", [buyer.address]), asset = await token.getAddress();
    await fn(c, "setAllowedAsset")(asset, true);
    await fn(c.connect(seller), "updateProduct")(key, terms({ token: asset }), receiving("seller"));
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 2000n);
    await fn(token, "setFee")(true);
    await expect(f.buy({ value: 0n })).to.be.revertedWithCustomError(c, "InexactTransfer");
    expect(await fn(c, "nextOrderId")()).to.equal(1n);
    await fn(token, "setFee")(false);
    const id = await f.buy({ value: 0n });
    await fn(token, "setFee")(true);
    await expect(fn(c.connect(buyer), "claimRefund")(id)).to.be.revertedWithCustomError(c, "InexactTransfer");
    expect(await fn(c, "liabilities")(asset)).to.equal(1000n);
    expect(await fn(token, "balanceOf")(await c.getAddress())).to.equal(1000n);
    await fn(token, "setFee")(false);
    await fn(c.connect(buyer), "claimRefund")(id);
  });

  it("maintains solvency and terminal states over a seeded mixed-asset lifecycle sequence", async function () {
    const { escrow: c, seller, buyer, token, key, ethers } = f;
    const asset = await token.getAddress(), tokenKey = h("token-product");
    await fn(c.connect(seller), "createProduct")(tokenKey, terms({ token: asset }), receiving("seller"), 0, 0, 0);
    await fn(token, "transfer")(buyer.address, 100000n);
    await fn(token.connect(buyer), "approve")(await c.getAddress(), 100000n);
    let seed = 0x24681357;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const expected = new Map([[ZeroAddress, 0n], [asset, 0n]]);
    const pending: { id: bigint; asset: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const isToken = (next() & 2) !== 0, a = isToken ? asset : ZeroAddress;
      const id = await f.buy({ key: isToken ? tokenKey : key, value: isToken ? 0n : 1000n });
      expected.set(a, expected.get(a)! + 1000n); pending.push({ id, asset: a });
      if ((next() & 3) !== 0) {
        const index = next() % pending.length, item = pending.splice(index, 1)[0]!;
        if ((next() & 4) !== 0) {
          await f.fulfill(item.id); await fn(c.connect(buyer), "confirmReceipt")(item.id); await fn(c.connect(seller), "withdrawSeller")(item.id);
        } else await fn(c.connect(buyer), "claimRefund")(item.id);
        expected.set(item.asset, expected.get(item.asset)! - 1000n);
        await expect(fn(c.connect(buyer), "claimRefund")(item.id)).to.be.revertedWithCustomError(c, "InvalidState");
      }
      for (const a of [ZeroAddress, asset]) expect(await fn(c, "liabilities")(a)).to.equal(expected.get(a));
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(expected.get(ZeroAddress));
      expect(await fn(token, "balanceOf")(await c.getAddress())).to.equal(expected.get(asset));
    }
  });
});
