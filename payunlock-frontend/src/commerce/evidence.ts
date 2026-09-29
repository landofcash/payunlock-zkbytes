import { clearItemKeys, prepareItem, sealSeed, encodeBase64, openSealedSeed, decodeBase64, decryptStorageItem, type MasterMessageSigner, type StorageItem, type SigningKeyDescriptor } from "@zkbytes/sdk";
import { z } from "zod";
import { canonical, strictJson, commitment, utf8 } from "@/crypto/encoding";
import { contentHash, expiration, OpeningSchema, OrderSchema, type Opening, type Order } from "./protocol";
import { encryptWithPassword, decryptWithPassword } from "@/crypto/password-envelope";
import { verifyRequest, requestHash, type RequestOpening } from "./requests";
import type { LocalStore } from "@/storage/local-store";

const AssignmentSchema = z.strictObject({ caseId: z.string().regex(/^[1-9][0-9]*$/), revision: z.string().regex(/^[1-9][0-9]*$/), wallet: z.string().regex(/^0x[0-9a-f]{40}$/), keyVersion: z.string().regex(/^[1-9][0-9]*$/), publicKey: z.string() });
export type Assignment = z.infer<typeof AssignmentSchema>;
const EvidenceSchema = z.strictObject({ version: z.literal(2), order: OrderSchema, assignment: AssignmentSchema, originals: z.array(OpeningSchema).max(100), unreadable: z.array(z.string()).max(100), requests: z.array(z.custom<RequestOpening>()).max(100).default([]) });
export function verifyEvidence(originals: Opening[], expected: readonly string[], order: Order) {
  const available = new Set<string>();
  let priorPosition = -1;
  if (new Set(expected).size !== expected.length) throw new Error("Duplicate expected evidence commitment.");
  for (const opening of originals) {
    const hash = contentHash(opening);
    if (canonical(opening.order) !== canonical(order) || !expected.includes(hash) || available.has(hash)) throw new Error("Evidence does not match original on-chain commitments.");
    const position = expected.indexOf(hash);
    if (position <= priorPosition) throw new Error("Evidence sequence does not match on-chain history.");
    priorPosition = position;
    available.add(hash);
  }
  return { verified: [...available], missing: expected.filter(hash => !available.has(hash)) };
}
function verifyRequests(requests: RequestOpening[], expected: string[], order: Order, sequences: string[]) {
  const seen = new Set<string>();
  for (const opening of requests) {
    const hash = requestHash(opening.record);
    if (!expected.includes(hash) || seen.has(hash)) throw new Error("Handover request is not an original finalized request.");
    verifyRequest(opening, hash, order, sequences); seen.add(hash);
  }
}
export async function prepareEvidence(input: { originals: Opening[]; expected: string[]; order: Order; assignment: Assignment; unreadable: string[]; requests?: RequestOpening[]; expectedRequests?: string[]; availableSequences?: string[]; signer: MasterMessageSigner; serviceId: number; maxRetentionSeconds: number; latestPublicationSeconds: bigint; isCurrent: () => boolean }) {
  const sender = input.signer.address.toLowerCase();
  if (![input.order.buyer.context.account, input.order.seller.context.account].includes(sender)) throw new Error("Only a participant may prepare evidence.");
  const report = verifyEvidence(input.originals, input.expected, input.order);
  if (new Set(input.unreadable).size !== input.unreadable.length || input.originals.length + input.unreadable.length > 100 || input.unreadable.some(hash => !report.missing.includes(hash))) throw new Error("Unreadable evidence must identify a missing original commitment.");
  if (!Number.isInteger(input.serviceId) || input.serviceId < 1 || input.serviceId > 4294967295) throw new Error("Unsupported storage service.");
  verifyRequests(input.requests ?? [], input.expectedRequests ?? [], input.order, input.availableSequences ?? []);
  const evidence = EvidenceSchema.parse({ version: 2, order: input.order, assignment: input.assignment, originals: input.originals, unreadable: input.unreadable, requests: input.requests ?? [] });
  const plaintext = canonical(evidence);
  if (utf8(plaintext).length > 65536) throw new Error("Evidence bundle exceeds 64 KiB. Submit smaller supplemental copies.");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const expiresAt = expiration(now, input.latestPublicationSeconds, input.order.terms, input.maxRetentionSeconds);
  if (!input.isCurrent()) throw new Error("Assignment/session changed.");
  const prepared = await prepareItem({ plaintext, expiresAt, managers: [], recipientPublicKeys: [input.order.buyer.publicKey, input.order.seller.publicKey, input.assignment.publicKey], signer: input.signer });
  try {
    const envelopes = await Promise.all([input.order.buyer.publicKey, input.order.seller.publicKey, input.assignment.publicKey].map(async key => encodeBase64(await sealSeed(prepared.item.seed, key))));
    if (!input.isCurrent()) throw new Error("Assignment/session changed.");
    const record = { version: 2 as const, order: input.order, assignment: input.assignment, serviceId: input.serviceId, profile: prepared.item.keyDerivationProfile, preparedAt: new Date(now).toISOString(), expiresAt, creator: prepared.item.creator, envelopes, evidenceHash: commitment("payunlock-evidence-v2", evidence) };
    return { item: prepared.item, record, recordHash: commitment("payunlock-evidence-record-v2", record), report };
  } finally { clearItemKeys(prepared.keys); }
}
export type PreparedEvidence = Awaited<ReturnType<typeof prepareEvidence>>;
export async function openEvidence(input: { record: PreparedEvidence["record"]; expectedRecordHash: string; role: "buyer" | "seller" | "arbitrator"; privateKey: Uint8Array; serviceId: number; download: (seed: string, creator: SigningKeyDescriptor) => Promise<StorageItem>; assignment: Assignment; order: Order; expected: string[]; expectedRequests?: string[]; availableSequences?: string[]; isCurrent: () => boolean }) {
  if (!input.isCurrent()) throw new Error("Assignment/session changed.");
  const record = input.record;
  if (commitment("payunlock-evidence-record-v2", record) !== input.expectedRecordHash || record.serviceId !== input.serviceId || canonical(record.assignment) !== canonical(input.assignment) || canonical(record.order) !== canonical(input.order)) throw new Error("Evidence/assignment mismatch.");
  const seed = await openSealedSeed(decodeBase64(record.envelopes[["buyer", "seller", "arbitrator"].indexOf(input.role)]!, 65), input.privateKey);
  const item = await input.download(seed, record.creator);
  if (!input.isCurrent()) throw new Error("Assignment/session changed.");
  if (item.expiresAt !== record.expiresAt || item.managers.length) throw new Error("Evidence policy mismatch.");
  const opened = await decryptStorageItem(item, record.creator, input.privateKey);
  if (!Number.isInteger(input.serviceId) || input.serviceId < 1 || input.serviceId > 4294967295) throw new Error("Unsupported storage service.");
  const evidence = EvidenceSchema.parse(strictJson(opened.plaintext));
  if (opened.expired || !input.isCurrent() || canonical(evidence.assignment) !== canonical(input.assignment) || canonical(evidence.order) !== canonical(input.order) || commitment("payunlock-evidence-v2", evidence) !== record.evidenceHash) throw new Error("Evidence/assignment mismatch.");
  const report = verifyEvidence(evidence.originals, input.expected, input.order);
  if (new Set(evidence.unreadable).size !== evidence.unreadable.length || evidence.unreadable.some(h => !report.missing.includes(h)) || evidence.originals.length + evidence.unreadable.length > 100) throw new Error("Invalid unreadable evidence manifest.");
  verifyRequests(evidence.requests, input.expectedRequests ?? [], input.order, input.availableSequences ?? []);
  return { evidence, report };

}

// Persist the prepared upload, fixed assignment and encrypted references before upload/publication.
// On reassignment create a new copy; never overwrite the prior assignment's pending record.
export async function persistEvidence(store: LocalStore, prepared: PreparedEvidence, password: string, isCurrent: () => boolean) {
  const id = prepared.recordHash;
  if (commitment("payunlock-evidence-record-v2", prepared.record) !== id) throw new Error("Evidence record mismatch.");
  const encrypted = await encryptWithPassword(canonical(prepared), password, { domain: "payunlock-pending-evidence-v1", id });
  if (!isCurrent()) throw new Error("Assignment/session changed.");
  await store.compareAndSwap(`evidence:${id}`, undefined, encrypted);
  return id;
}
export async function restoreEvidence(store: LocalStore, id: string, password: string): Promise<PreparedEvidence> {
  const prepared = strictJson(await decryptWithPassword(await store.get(`evidence:${id}`), password, { domain: "payunlock-pending-evidence-v1", id })) as PreparedEvidence;
  if (prepared.recordHash !== id || commitment("payunlock-evidence-record-v2", prepared.record) !== id) throw new Error("Evidence recovery mismatch.");
  return prepared;
}
