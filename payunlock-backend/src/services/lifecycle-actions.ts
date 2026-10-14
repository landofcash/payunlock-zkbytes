import {z} from "zod";
import {address, ApiError, hash, nonzeroHash, orderId, uint} from "../domain.js";
import {ChainService, eligibility, escrowInterface} from "./chain-service.js";

const u64 = uint.refine(v => BigInt(v) < 2n ** 64n);
const envelope = z.string().regex(/^0x03[0-9a-fA-F]{128}$/);
export const referenceSchema = z.strictObject({
  serviceId: z.number().int().min(1).max(4294967295),
  preparedAt: u64,
  creator: nonzeroHash,
  buyerEnvelope: envelope,
  sellerEnvelope: envelope,
  contentHash: nonzeroHash
});
const evidence = z.strictObject({contentRef: referenceSchema, arbitratorEnvelope: envelope});
export const lifecycleSchemas = [
  z.strictObject({kind: z.literal("cancelProduct"), productKey: nonzeroHash}),
  z.strictObject({kind: z.literal("reserveDeliveries"), items: z.array(z.strictObject({orderId})).min(1).max(30)}),
  z.strictObject({
    kind: z.literal("publishDeliveries"),
    items: z.array(z.strictObject({orderId, reference: referenceSchema, reservationTransaction: hash})).min(1).max(30)
  }),
  z.strictObject({kind: z.literal("refundCanceledOrders"), orderIds: z.array(orderId).min(1).max(30)}),
  z.strictObject({kind: z.enum(["confirmReceipt", "refundDisputedOrder"]), orderId}),
  z.strictObject({kind: z.literal("reserveDelivery"), orderId}),
  z.strictObject({
    kind: z.literal("publishDelivery"),
    orderId,
    reference: referenceSchema,
    reservationTransaction: hash
  }),
  z.strictObject({kind: z.literal("openDispute"), orderId, reference: referenceSchema}),
  z.strictObject({kind: z.literal("replyToDispute"), orderId, expectedTurn: uint, reference: referenceSchema}),
  z.strictObject({
    kind: z.literal("requestArbitration"),
    orderId,
    wallet: address,
    expectedKeyVersion: u64,
    expectedFee: uint,
    expectedFeeVersion: u64,
    expectedFeeAsset: address,
    evidence
  }),
  z.strictObject({kind: z.literal("submitArbitrationEvidence"), orderId, revision: u64, evidence}),
  z.strictObject({
    kind: z.literal("requestArbitrationEvidence"),
    orderId,
    revision: u64,
    participant: address,
    expectedIndex: uint,
    request: evidence,
    advisoryDate: u64
  }),
  z.strictObject({kind: z.literal("resolveArbitration"), orderId, revision: u64, sellerWins: z.boolean()}),
  z.strictObject({
    kind: z.literal("replaceArbitrator"),
    orderId,
    revision: u64,
    replacement: address,
    expectedKeyVersion: u64,
    reason: nonzeroHash
  }),
  z.strictObject({kind: z.literal("setDefaultReviewWindow"), value: u64}),
  z.strictObject({kind: z.literal("setResponseWindow"), value: u64}),
  z.strictObject({kind: z.literal("setAllowedAsset"), asset: address, allowed: z.boolean()}),
  z.strictObject({kind: z.literal("setBatchLimit"), value: u64}),
  z.strictObject({kind: z.literal("addStorageService"), serviceId: z.number().int().min(1).max(4294967295)}),
  z.strictObject({
    kind: z.literal("setTimingBounds"),
    responseFloor: u64,
    commitmentFloor: z.number().int().min(1).max(4294967295),
    commitmentCeiling: z.number().int().min(1).max(4294967295)
  }),
  z.strictObject({
    kind: z.literal("configureArbitrator"),
    wallet: address,
    publicKey: nonzeroHash,
    active: z.boolean()
  }),
  z.strictObject({kind: z.literal("setMyArbitrationFee"), expectedVersion: u64, fee: uint}),
  z.strictObject({kind: z.literal("setServiceFee"), bps: z.number().int().min(0).max(10000), treasury: address}),
  z.strictObject({kind: z.literal("setOfferPlacementFee"), amount: uint}),
  z.strictObject({kind: z.literal("setArbitrationFeeAsset"), asset: address}),
  z.strictObject({kind: z.literal("setReceiveAuthorizationAsset"), asset: address, enabled: z.boolean()}),
  z.strictObject({
    kind: z.literal("setSellerFeeCap"),
    productKey: nonzeroHash,
    capBps: z.number().int().min(0).max(10000)
  }),
  z.strictObject({kind: z.literal("claimFees"), asset: address}),
] as const;
export const lifecycleSchema = z.discriminatedUnion("kind", lifecycleSchemas);
export type LifecycleAction = z.infer<typeof lifecycleSchema>;

export async function lifecycleRequest(chain: ChainService, wallet: string, action: LifecycleAction) {
  const block = await chain.anchor("latest");
  const require = (ok: boolean) => {
    if (!ok) throw new ApiError(409, "ACTION_NOT_AVAILABLE");
  };
  const admin = async () => {
    require(String((await chain.call("owner", [], block))[0]).toLowerCase() === wallet);
  };
  let args: unknown[];
  const value = "0";
  if (action.kind === "cancelProduct") {
    const product = (await chain.call("getProduct", [wallet, action.productKey], block))[0];
    require([1, 2].includes(Number(product.status)));
    args = [action.productKey];
  } else if (action.kind === "reserveDeliveries" || action.kind === "publishDeliveries" || action.kind === "refundCanceledOrders") {
    const ids = action.kind === "refundCanceledOrders" ? action.orderIds : action.items.map(i => i.orderId);
    require(new Set(ids).size === ids.length && ids.length <= Number((await chain.call("batchLimit", [], block))[0]));
    const snapshots = await chain.orders(ids, "latest");
    require(snapshots.every(s => s.order.seller === wallet && s.order.productKey === snapshots[0]!.order.productKey));
    if (action.kind === "reserveDeliveries") {
      require(snapshots.every(s => s.order.state === 1 && !s.canceled));
      args = [ids];
    } else if (action.kind === "refundCanceledOrders") {
      require(snapshots.every(s => s.canceled && [1, 2].includes(s.order.state)));
      args = [ids];
    } else {
      require((await chain.batchPublication(action.items, wallet, snapshots)).every(Boolean));
      args = [ids, action.items.map(i => i.reference)];
    }
  } else if (action.kind === "setDefaultReviewWindow" || action.kind === "setResponseWindow" || action.kind === "setBatchLimit") {
    await admin();
    args = [action.value];
  } else if (action.kind === "setAllowedAsset") {
    await admin();
    args = [action.asset, action.allowed];
  } else if (action.kind === "addStorageService") {
    await admin();
    args = [action.serviceId];
  } else if (action.kind === "setTimingBounds") {
    await admin();
    args = [action.responseFloor, action.commitmentFloor, action.commitmentCeiling];
  } else if (action.kind === "configureArbitrator") {
    await admin();
    args = [action.wallet, action.publicKey, action.active];
  } else if (action.kind === "setMyArbitrationFee") {
    const active = (await chain.call("arbitrators", [wallet], block))[0];
    const version = (await chain.call("arbitratorFeeVersion", [wallet], block))[0];
    require(Boolean(active) && BigInt(version) === BigInt(action.expectedVersion));
    args = [action.expectedVersion, action.fee];
  } else if (action.kind === "setServiceFee") {
    await admin();
    args = [action.bps, action.treasury];
  } else if (action.kind === "setOfferPlacementFee") {
    await admin();
    args = [action.amount];
  } else if (action.kind === "setArbitrationFeeAsset") {
    await admin();
    args = [action.asset];
  } else if (action.kind === "setReceiveAuthorizationAsset") {
    await admin();
    args = [action.asset, action.enabled];
  } else if (action.kind === "setSellerFeeCap") {
    await chain.call("getProduct", [wallet, action.productKey], block);
    args = [action.productKey, action.capBps];
  } else if (action.kind === "claimFees") {
    require(BigInt((await chain.call("accruedFees", [wallet, action.asset], block))[0]) > 0n);
    args = [action.asset];
  } else {
    const snapshot = await chain.order(action.orderId, "latest"), o = snapshot.order, e = eligibility(snapshot, wallet);
    if ("revision" in action) require(o.state === 6 && snapshot.assignment?.revision === action.revision);
    switch (action.kind) {
      case "reserveDelivery":
        require(o.seller === wallet && o.state === 1 && !snapshot.canceled);
        args = [action.orderId];
        break;
      case "publishDelivery": {
        require((await chain.publication(action.orderId, action.reservationTransaction, wallet)).eligible);
        args = [action.orderId, action.reference];
        break;
      }
      case "openDispute":
        require(e.openDispute);
        args = [action.orderId, action.reference];
        break;
      case "replyToDispute":
        require(e.reply && BigInt(action.expectedTurn) === BigInt(o.turn) + 1n);
        args = [action.orderId, action.expectedTurn, action.reference];
        break;
      case "confirmReceipt":
      case "refundDisputedOrder":
        require(e[action.kind]);
        args = [action.orderId];
        break;
      case "requestArbitration": {
        require(e.requestArbitration);
        const asset = String((await chain.call("arbitrationFeeAsset", [], block))[0]).toLowerCase();
        const version = String((await chain.call("arbitratorFeeVersion", [action.wallet], block))[0]);
        require(action.expectedFeeAsset === asset && action.expectedFeeVersion === version);
        args = [action.orderId, action.wallet, action.expectedKeyVersion, action.expectedFeeVersion, action.expectedFee, action.expectedFeeAsset, action.evidence];
        break;
      }
      case "submitArbitrationEvidence":
        require([o.buyer, o.seller].includes(wallet));
        args = [action.orderId, action.revision, action.evidence];
        break;
      case "requestArbitrationEvidence":
        require(e.resolveArbitration);
        args = [action.orderId, action.revision, action.expectedIndex, action.participant, action.advisoryDate, action.request];
        break;
      case "resolveArbitration":
        require(e.resolveArbitration);
        args = [action.orderId, action.revision, action.sellerWins];
        break;
      case "replaceArbitrator":
        await admin();
        args = [action.orderId, action.revision, action.replacement, action.expectedKeyVersion, action.reason];
        break;
    }
  }
  await chain.ensureCanonical(block);
  return {data: escrowInterface.encodeFunctionData(action.kind, args), value};
}
