import { encodeBase64, decodeBase64, KEY_DERIVATION_PROFILE, ZkbytesClient } from "@zkbytes/sdk";
import { getBytes, hexlify, id } from "ethers";
import type { OrderView } from "./client";
import { RecordSchema, OrderSchema, RETENTION_SECONDS, type DeliveryRecord, type Order } from "./protocol";
import type { PreparedEvidence, Assignment } from "./evidence";

export type Reference = { serviceId: number; preparedAt: string; creator: string; buyerEnvelope: string; sellerEnvelope: string; contentHash: string };
export type EvidenceReference = { contentRef: Reference; arbitratorEnvelope: string };
export type ChainRecord = { turn: string; commitment: string; sender: string; reference: Reference };
export type ChainAssignment = { wallet: string; publicKey: string; keyVersion: string; revision: string; fee: string; requester: string; handoverRecorded: boolean };
export type Arbitrator = { wallet: string; active: boolean; publicKey: string; keyVersion: string; fee: string; feeVersion?: string };
export type LifecycleAction =
  | { kind: "cancelProduct"; productKey: string }
  | { kind: "reserveDeliveries"; items: { orderId: string }[] }
  | { kind: "publishDeliveries"; items: { orderId: string; reference: Reference; reservationTransaction: string }[] }
  | { kind: "refundCanceledOrders"; orderIds: string[] }
  | { kind: "confirmReceipt" | "refundDisputedOrder"; orderId: string }
  | { kind: "reserveDelivery"; orderId: string }
  | { kind: "publishDelivery"; orderId: string; reference: Reference; reservationTransaction: string }
  | { kind: "openDispute"; orderId: string; reference: Reference }
  | { kind: "replyToDispute"; orderId: string; expectedTurn: string; reference: Reference }
  | { kind: "requestArbitration"; orderId: string; wallet: string; expectedKeyVersion: string; expectedFee: string; expectedFeeVersion?: string; expectedFeeAsset?: string; evidence: EvidenceReference }
  | { kind: "submitArbitrationEvidence"; orderId: string; revision: string; evidence: EvidenceReference }
  | { kind: "requestArbitrationEvidence"; orderId: string; revision: string; participant: string; expectedIndex: string; request: EvidenceReference; advisoryDate: string }
  | { kind: "resolveArbitration"; orderId: string; revision: string; sellerWins: boolean }
  | { kind: "replaceArbitrator"; orderId: string; revision: string; replacement: string; expectedKeyVersion: string; reason: string }
  | { kind: "setDefaultReviewWindow" | "setResponseWindow" | "setBatchLimit"; value: string }
  | { kind: "setAllowedAsset"; asset: string; allowed: boolean }
  | { kind: "addStorageService"; serviceId: number }
  | { kind: "setTimingBounds"; responseFloor: string; commitmentFloor: number; commitmentCeiling: number }
  | { kind: "configureArbitrator"; wallet: string; publicKey: string; fee: string; active: boolean }
  | { kind: "setMyArbitrationFee"; expectedVersion: string; fee: string }
  | { kind: "setServiceFee"; bps: number; treasury: string }
  | { kind: "setOfferPlacementFee"; amount: string }
  | { kind: "setArbitrationFeeAsset"; asset: string }
  | { kind: "setReceiveAuthorizationAsset"; asset: string; enabled: boolean }
  | { kind: "claimFees"; asset: string };
export const base64Key = (hex: string) => encodeBase64(getBytes(hex));
export const hexKey = (base64: string) => hexlify(decodeBase64(base64, 32));
export const deploymentIdentity = (value: Order["deployment"]): Order["deployment"] => ({ chainId: value.chainId, contract: value.contract.toLowerCase() });
export function protocolOrder(view: OrderView, deployment: Order["deployment"]): Order {
  deployment = deploymentIdentity(deployment);
  const o = view.order;
  const recipient = (role: "buyer" | "seller") => ({ context: { version: 1, deployment, account: o[role], nonce: o[`${role}Receiving`].nonce }, publicKey: base64Key(o[`${role}Receiving`].publicKey) });
  return OrderSchema.parse({ deployment, orderId: view.orderId, buyer: recipient("buyer"), seller: recipient("seller"), terms: { version: 1, token: o.terms.token.toLowerCase(), price: o.terms.price, eventEnd: o.terms.hasEventEnd ? o.terms.eventEnd : null, reviewWindow: o.terms.reviewWindow, responseWindow: o.terms.responseWindow } });
}
export function reference(record: DeliveryRecord): Reference {
  return { serviceId: record.serviceId, preparedAt: String(Date.parse(record.preparedAt) / 1000), creator: hexKey(record.creator.publicKey), buyerEnvelope: hexlify(decodeBase64(record.buyerEnvelope, 65)), sellerEnvelope: hexlify(decodeBase64(record.sellerEnvelope, 65)), contentHash: record.contentHash };
}
export function deliveryRecord(row: ChainRecord, order: Order): DeliveryRecord {
  const r = row.reference, prepared = Number(r.preparedAt) * 1000;
  return RecordSchema.parse({ version: 2, order, kind: row.turn === "0" ? "delivery" : "message", sender: row.sender, turn: row.turn, serviceId: r.serviceId, profile: KEY_DERIVATION_PROFILE, preparedAt: new Date(prepared).toISOString(), expiresAt: new Date(prepared + RETENTION_SECONDS * 1000).toISOString().replace(".000Z", "Z"), creator: { signatureScheme: "zkbytes-ed25519-v1", publicKey: base64Key(r.creator) }, buyerEnvelope: base64Key(r.buyerEnvelope), sellerEnvelope: base64Key(r.sellerEnvelope), contentHash: r.contentHash });
}
export const assignment = (orderId: string, a: Pick<ChainAssignment, "wallet" | "publicKey" | "keyVersion" | "revision">): Assignment => ({ caseId: orderId, wallet: a.wallet, publicKey: base64Key(a.publicKey), keyVersion: a.keyVersion, revision: a.revision });
export const arbitratorContext = (deployment: Order["deployment"], account: string) => ({ version: 1 as const, deployment: deploymentIdentity(deployment), account: account.toLowerCase(), nonce: id("payunlock-arbitrator-receiving-v1") });
export function evidenceReference(prepared: Pick<PreparedEvidence, "record">): EvidenceReference {
  const r = prepared.record;
  return { contentRef: { serviceId: r.serviceId, preparedAt: String(Date.parse(r.preparedAt) / 1000), creator: hexKey(r.creator.publicKey), buyerEnvelope: hexlify(decodeBase64(r.envelopes[0]!, 65)), sellerEnvelope: hexlify(decodeBase64(r.envelopes[1]!, 65)), contentHash: r.evidenceHash }, arbitratorEnvelope: hexlify(decodeBase64(r.envelopes[2]!, 65)) };
}
export function evidenceRecord(e: EvidenceReference, a: Assignment, order: Order): PreparedEvidence["record"] {
  const r = e.contentRef, prepared = Number(r.preparedAt) * 1000;
  return { version: 2, order, assignment: a, serviceId: r.serviceId, profile: KEY_DERIVATION_PROFILE, preparedAt: new Date(prepared).toISOString(), expiresAt: new Date(prepared + RETENTION_SECONDS * 1000).toISOString().replace(".000Z", "Z"), creator: { signatureScheme: "zkbytes-ed25519-v1", publicKey: base64Key(r.creator) }, envelopes: [base64Key(r.buyerEnvelope), base64Key(r.sellerEnvelope), base64Key(e.arbitratorEnvelope)], evidenceHash: r.contentHash };
}
export function storageService(config: { adapter?: "zkbytes-v1"; id: number; apiOrigin: string; downloadOrigin: string; maxRetentionSeconds: number }) {
  if ((config.id !== 1 && config.adapter !== "zkbytes-v1") || !Number.isInteger(config.id) || config.id < 1 || config.id > 4294967295) throw new Error("Unsupported storage service.");
  return { id: config.id, maxRetentionSeconds: config.maxRetentionSeconds, client: new ZkbytesClient(config) };
}
