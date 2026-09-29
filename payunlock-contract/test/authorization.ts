import { expect } from "chai";
import { network } from "hardhat";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { AbiCoder, keccak256, toUtf8Bytes, ZeroAddress, type BaseContract } from "ethers";

const h = (value: string) => keccak256(toUtf8Bytes(value));
const fn = (contract: BaseContract, name: string) => contract.getFunction(name);
const receiving = (name: string) => ({ nonce: h(`${name}:nonce`), publicKey: h(`${name}:key`) });
const terms = (token: string) => ({ token, price: 100_000_000n, hasEventEnd: false, eventEnd: 0, hasReviewOverride: false, reviewOverride: 0, commitmentWindow: 600 });

const Fixture = buildModule("AuthorizedPaymentFixture", m => {
  const admin = m.getParameter<string>("admin");
  const codec = m.library("PayUnlockCodec");
  const arbitration = m.library("PayUnlockArbitration", { libraries: { PayUnlockCodec: codec } });
  const transfers = m.library("PayUnlockTransfers");
  const escrow = m.contract("PayUnlock", [admin, 86400, 60, 60, 86400], { libraries: { PayUnlockCodec: codec, PayUnlockArbitration: arbitration, PayUnlockTransfers: transfers } });
  const router = m.contract("PayUnlockAuthorizationRouter", [escrow]);
  const token = m.contract("MockReceiveAuthorizationToken", [admin]);
  const sender = { from: m.getAccount(0) };
  m.call(escrow, "setAuthorizationRouter", [router], sender);
  const allowToken = m.call(escrow, "setAllowedAsset", [token, true], sender);
  m.call(escrow, "setReceiveAuthorizationAsset", [token, true], { ...sender, after: [allowToken] });
  m.call(escrow, "setArbitrationFeeAsset", [token], { ...sender, after: [allowToken] });
  return { escrow, router, token };
});

async function setup() {
  const connection = await network.create();
  const { ethers, networkHelpers } = connection;
  const [admin, seller, buyer, relayer, arbitrator] = await ethers.getSigners();
  if (!admin || !seller || !buyer || !relayer || !arbitrator) throw new Error("Missing signers");
  const { escrow, router, token } = await connection.ignition.deploy(Fixture, { parameters: { AuthorizedPaymentFixture: { admin: admin.address } } });
  await fn(escrow, "setServiceFee")(250, admin.address);
  await fn(escrow, "setOfferPlacementFee")(50);
  const key = h("sponsored-product");
  await fn(escrow.connect(seller), "createProduct")(key, terms(await token.getAddress()), receiving("seller"), 300, 50, 1, { value: 50 });
  await fn(token, "mint")(buyer.address, 500_000_000n);
  const reference = async () => ({ serviceId: 1, preparedAt: BigInt(await networkHelpers.time.latest()), creator: h("creator"), buyerEnvelope: "0x03" + "11".repeat(64), sellerEnvelope: "0x03" + "22".repeat(64), contentHash: h("content") });
  return { connection, ethers, networkHelpers, admin, seller, buyer, relayer, arbitrator, escrow, router, token, key, reference };
}

type FixtureResult = Awaited<ReturnType<typeof setup>>;
async function signReceive(f: FixtureResult, nonce: string, value: bigint, validAfter: bigint, validBefore: bigint) {
  return f.buyer.signTypedData(
    { name: "USDC", version: "2", chainId: 31337, verifyingContract: await f.token.getAddress() },
    { ReceiveWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    { from: f.buyer.address, to: await f.router.getAddress(), value, validAfter, validBefore, nonce },
  );
}
async function purchasePacket(f: FixtureResult, request: string) {
  const intent = { seller: f.seller.address, productKey: f.key, requestId: request, expectedCheckoutHash: await fn(f.escrow, "checkoutHash")(f.seller.address, f.key), receiving: receiving("buyer") };
  const auth = { actor: f.buyer.address, validAfter: 0n, validBefore: BigInt(await f.networkHelpers.time.latest()) + 3600n, salt: h(`salt:${request}`), signature: "0x" };
  const nonce = await fn(f.router, "purchaseNonce")(intent, auth);
  auth.signature = await signReceive(f, nonce, 100_000_000n, auth.validAfter, auth.validBefore);
  return { intent, auth, nonce };
}

describe("authorized token payments", function () {
  let f: FixtureResult;
  beforeEach(async () => { f = await setup(); });
  afterEach(async () => { await f?.connection.close(); });

  it("allows only the intended lifecycle selectors through the action router", async () => {
    const permitted = ["updateProduct", "setSalesDisabled", "cancelProduct", "setSellerFeeCap", "reserveDelivery",
      "reserveDeliveries", "publishDelivery", "publishDeliveries", "claimRefund", "refundCanceledOrders", "claimFees",
      "confirmReceipt", "withdrawSeller", "openDispute", "replyToDispute", "refundDisputedOrder",
      "claimResponseTimeout", "submitArbitrationEvidence", "requestArbitrationEvidence", "resolveArbitration", "setMyArbitrationFee"];
    for (const name of permitted) {
      const selector = f.escrow.interface.getFunction(name)!.selector;
      expect(await fn(f.router, "isAllowedAction")(selector), name).to.equal(true);
    }
    for (const name of ["createProduct", "purchase", "requestArbitration", "setServiceFee",
      "setOfferPlacementFee", "setAllowedAsset", "configureArbitrator", "replaceArbitrator", "setAuthorizationRouter"]) {
      expect(await fn(f.router, "isAllowedAction")(f.escrow.interface.getFunction(name)!.selector), name).to.equal(false);
    }
  });

  it("allows any relayer to buy with one order-bound token signature and no buyer MON", async () => {
    const packet = await purchasePacket(f, h("purchase-1"));
    await f.networkHelpers.setBalance(f.buyer.address, 0n);
    await expect(fn(f.token.connect(f.relayer), "receiveWithAuthorization")(f.buyer.address, await f.router.getAddress(), 100_000_000n, packet.auth.validAfter, packet.auth.validBefore, packet.nonce, packet.auth.signature)).to.be.revertedWith("caller must be payee");
    await fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth);
    expect(await fn(f.escrow, "orderForRequest")(f.buyer.address, packet.intent.requestId)).to.equal(1n);
    expect((await fn(f.escrow, "getOrder")(1)).buyer).to.equal(f.buyer.address);
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(400_000_000n);
    expect(await f.ethers.provider.getBalance(f.buyer.address)).to.equal(0n);
    const fee = await fn(f.escrow, "orderFees")(1);
    expect(fee.amount).to.equal(2_500_000n);
    await expect(fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth)).to.be.revertedWith("authorization used");
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(400_000_000n);
  });

  it("rejects altered order fields and refunds the full principal", async () => {
    const packet = await purchasePacket(f, h("purchase-2"));
    await expect(fn(f.router.connect(f.relayer), "purchaseWithAuthorization")({ ...packet.intent, receiving: receiving("attacker") }, packet.auth)).to.be.revertedWith("invalid signature");
    await fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth);
    await fn(f.escrow.connect(f.buyer), "claimRefund")(1);
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(500_000_000n);
    expect(await fn(f.escrow, "accruedFees")(f.admin.address, await f.token.getAddress())).to.equal(0n);
    expect(await fn(f.escrow, "accruedFees")(f.admin.address, ZeroAddress)).to.equal(50n);
  });

  it("snapshots seller fee, accrues it once, and leaves admin changes unable to reprice the order", async () => {
    const packet = await purchasePacket(f, h("purchase-3"));
    await fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth);
    await fn(f.escrow, "setServiceFee")(100, f.relayer.address);
    await fn(f.escrow.connect(f.seller), "reserveDelivery")(1);
    await fn(f.escrow.connect(f.seller), "publishDelivery")(1, await f.reference());
    await fn(f.escrow.connect(f.buyer), "confirmReceipt")(1);
    await fn(f.escrow.connect(f.seller), "withdrawSeller")(1);
    expect(await fn(f.token, "balanceOf")(f.seller.address)).to.equal(97_500_000n);
    expect(await fn(f.escrow, "accruedFees")(f.admin.address, await f.token.getAddress())).to.equal(2_500_000n);
    expect(await fn(f.escrow, "accruedFees")(f.relayer.address, await f.token.getAddress())).to.equal(0n);
    const data = f.escrow.interface.encodeFunctionData("claimFees", [await f.token.getAddress()]);
    const authorization = { actor: f.admin.address, nonce: h("treasury-claim"), validAfter: 0n, validBefore: BigInt(await f.networkHelpers.time.latest()) + 3600n };
    const signature = await f.admin.signTypedData(
      { name: "PayUnlockActionRouter", version: "1", chainId: 31337, verifyingContract: await f.router.getAddress() },
      { PayUnlockAction: [
        { name: "actor", type: "address" }, { name: "escrow", type: "address" }, { name: "actionHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
      ] }, { ...authorization, escrow: await f.escrow.getAddress(), actionHash: keccak256(data) },
    );
    await f.networkHelpers.setBalance(f.admin.address, 0n);
    await fn(f.router.connect(f.relayer), "executeAuthorized")(authorization, data, signature);
    expect(await fn(f.token, "balanceOf")(f.admin.address)).to.equal(1_000_002_500_000n);
    expect(await fn(f.escrow, "accruedFees")(f.admin.address, await f.token.getAddress())).to.equal(0n);
  });

  it("lets an initiator pay the arbitrator's USDC quote through a relayer without touching principal", async () => {
    const packet = await purchasePacket(f, h("arbitrated-purchase"));
    await fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth);
    await fn(f.escrow.connect(f.seller), "reserveDelivery")(1);
    await fn(f.escrow.connect(f.seller), "publishDelivery")(1, await f.reference());
    await fn(f.escrow.connect(f.buyer), "openDispute")(1, await f.reference());
    await fn(f.escrow, "configureArbitrator")(f.arbitrator.address, h("arbitrator-key"), true);
    await fn(f.escrow.connect(f.arbitrator), "setMyArbitrationFee")(0, 5_000_000n);
    const evidence = { contentRef: await f.reference(), arbitratorEnvelope: "0x03" + "33".repeat(64) };
    const intent = { orderId: 1n, arbitrator: f.arbitrator.address, keyVersion: 1, feeVersion: 1, fee: 5_000_000n, evidence };
    const auth = { actor: f.buyer.address, validAfter: 0n, validBefore: BigInt(await f.networkHelpers.time.latest()) + 3600n, salt: h("arbitration-salt"), signature: "0x" };
    const nonce = await fn(f.router, "arbitrationNonce")(intent, auth);
    const evidenceHash = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["tuple(tuple(uint32 serviceId,uint64 preparedAt,bytes32 creator,bytes buyerEnvelope,bytes sellerEnvelope,bytes32 contentHash) contentRef,bytes arbitratorEnvelope)"], [evidence],
    ));
    const beforeActivation = await fn(f.escrow, "getOrder")(1);
    const localNonce = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "address", "address", "uint256", "address", "uint64", "uint64", "uint256", "bytes32", "uint256", "uint64", "uint256", "uint256", "bytes32"],
      [keccak256(toUtf8Bytes("PayUnlockArbitrationV1(uint256 chainId,address escrow,address router,address token,address requester,uint256 orderId,address arbitrator,uint64 keyVersion,uint64 feeVersion,uint256 fee,bytes32 evidenceHash,uint256 turn,uint64 responseDeadline,uint256 validAfter,uint256 validBefore,bytes32 salt)")),
        31337, await f.escrow.getAddress(), await f.router.getAddress(), await f.token.getAddress(), f.buyer.address, 1,
        f.arbitrator.address, 1, 1, 5_000_000, evidenceHash, beforeActivation.turn, beforeActivation.responseDeadline,
        auth.validAfter, auth.validBefore, auth.salt],
    ));
    expect(localNonce).to.equal(nonce);
    auth.signature = await signReceive(f, nonce, intent.fee, auth.validAfter, auth.validBefore);
    await f.networkHelpers.setBalance(f.buyer.address, 0n);
    await fn(f.router.connect(f.relayer), "requestArbitrationWithAuthorization")(intent, auth);
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(395_000_000n);
    expect(await fn(f.token, "balanceOf")(f.arbitrator.address)).to.equal(5_000_000n);
    expect(await fn(f.escrow, "liabilities")(await f.token.getAddress())).to.equal(100_000_000n);
    expect((await fn(f.escrow, "getAssignment")(1)).requester).to.equal(f.buyer.address);
    expect(await fn(f.escrow, "assignmentFeeAsset")(1)).to.equal(await f.token.getAddress());
    await fn(f.escrow.connect(f.arbitrator), "resolveArbitration")(1, 1, false);
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(495_000_000n);
    expect(await fn(f.escrow, "accruedFees")(f.admin.address, await f.token.getAddress())).to.equal(0n);
  });

  it("executes bounded buyer actions from any relayer and rejects replay and admin selectors", async () => {
    const packet = await purchasePacket(f, h("action-purchase"));
    await fn(f.router.connect(f.relayer), "purchaseWithAuthorization")(packet.intent, packet.auth);
    const data = f.escrow.interface.encodeFunctionData("claimRefund", [1]);
    const authorization = { actor: f.buyer.address, nonce: h("refund-action"), validAfter: 0n, validBefore: BigInt(await f.networkHelpers.time.latest()) + 3600n };
    const signature = await f.buyer.signTypedData(
      { name: "PayUnlockActionRouter", version: "1", chainId: 31337, verifyingContract: await f.router.getAddress() },
      { PayUnlockAction: [
        { name: "actor", type: "address" }, { name: "escrow", type: "address" }, { name: "actionHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
      ] },
      { ...authorization, escrow: await f.escrow.getAddress(), actionHash: keccak256(data) },
    );
    await f.networkHelpers.setBalance(f.buyer.address, 0n);
    await fn(f.router.connect(f.relayer), "executeAuthorized")(authorization, data, signature);
    expect((await fn(f.escrow, "getOrder")(1)).state).to.equal(9n);
    expect(await fn(f.token, "balanceOf")(f.buyer.address)).to.equal(500_000_000n);
    await expect(fn(f.router.connect(f.relayer), "executeAuthorized")(authorization, data, signature)).to.be.revertedWithCustomError(f.router, "InvalidIntent");
    await expect(fn(f.escrow.connect(f.relayer), "executeFromRouter")(f.buyer.address, data)).to.be.revertedWithCustomError(f.escrow, "Unauthorized");
    const adminData = f.escrow.interface.encodeFunctionData("setServiceFee", [100, f.relayer.address]);
    await expect(fn(f.router.connect(f.admin), "executeDirect")({ actor: f.admin.address, nonce: h("admin-attempt"), validAfter: 0, validBefore: authorization.validBefore }, adminData)).to.be.revertedWithCustomError(f.router, "InvalidIntent");
  });
});
