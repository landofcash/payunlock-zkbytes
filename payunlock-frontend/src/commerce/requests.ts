import {z} from "zod";
import {AbiCoder, id, keccak256} from "ethers";
import {
  clearItemKeys,
  decodeBase64,
  decryptStorageItem,
  encodeBase64,
  type MasterMessageSigner,
  openSealedSeed,
  prepareItem,
  randomBytes,
  sealSeed
} from "@zkbytes/sdk";
import {canonical, commitment, strictJson, utf8} from "@/crypto/encoding";
import {decryptWithPassword, encryptWithPassword} from "@/crypto/password-envelope";
import type {LocalStore} from "@/storage/local-store";
import {expiration, type Order, type Service} from "./protocol";
import type {Assignment, PreparedEvidence} from "./evidence";
import {assignment, type ChainAssignment, evidenceRecord, type EvidenceReference} from "./lifecycle";

const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 2n ** 256n);
export const RequestContentSchema = z.strictObject({
  version: z.literal(2),
  salt: z.string().regex(/^0x[0-9a-f]{64}$/),
  sequences: z.array(uint).max(100),
  instructions: z.string().max(32000)
});
export type RequestContent = z.infer<typeof RequestContentSchema>;
export type RequestRow = {
  id: string;
  index: string;
  revision: string;
  participant: string;
  advisoryDate: string;
  commitment: string;
  assignment: ChainAssignment;
  data: EvidenceReference
};
export type RequestRecord = {
  reference: PreparedEvidence["record"];
  index: string;
  participant: string;
  advisoryDate: string
};
export type RequestOpening = { record: RequestRecord; content: RequestContent };
export type PreparedRequest = RequestOpening & { recordHash: string; item: PreparedEvidence["item"] };

export function requestHash(record: RequestRecord) {
  const r = record.reference, a = r.assignment;
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "uint256", "uint256", "uint64", "address", "uint64", "address", "uint64", "bytes32"],
    [id("payunlock-request-record-v2"), r.order.deployment.chainId, r.order.deployment.contract, r.order.orderId, record.index, a.revision, a.wallet, a.keyVersion, record.participant, record.advisoryDate, commitment("payunlock-evidence-record-v2", r)],
  ));
}

export function verifyRequest(opening: RequestOpening, expected: string, order: Order, availableSequences: string[]) {
  const c = RequestContentSchema.parse(opening.content), r = opening.record;
  if (canonical(r.reference.order) !== canonical(order) || requestHash(r) !== expected || commitment("payunlock-request-content-v2", c) !== r.reference.evidenceHash) throw new Error("Request integrity mismatch.");
  if (![order.buyer.context.account, order.seller.context.account].includes(r.participant)) throw new Error("Invalid request respondent.");
  if (c.sequences.some((v, i) => !availableSequences.includes(v) || (i > 0 && BigInt(v) <= BigInt(c.sequences[i - 1]!)))) throw new Error("Requested sequences must exist and be strictly increasing.");
  return c;
}

export function requestRecord(row: RequestRow, order: Order): RequestRecord {
  return {
    reference: evidenceRecord(row.data, assignment(order.orderId, row.assignment), order),
    index: row.index,
    participant: row.participant,
    advisoryDate: row.advisoryDate
  };
}

export async function prepareRequest(input: {
  order: Order;
  assignment: Assignment;
  index: string;
  participant: string;
  advisoryDate: string;
  sequences: string[];
  instructions: string;
  availableSequences: string[];
  signer: MasterMessageSigner;
  service: Service;
  isCurrent(): boolean
}): Promise<PreparedRequest> {
  if (input.signer.address.toLowerCase() !== input.assignment.wallet || !input.isCurrent()) throw new Error("Request assignment/service mismatch.");
  const content = RequestContentSchema.parse({
    version: 2,
    salt: `0x${Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("")}`,
    sequences: input.sequences,
    instructions: input.instructions
  });
  const plaintext = canonical(content);
  if (utf8(plaintext).length > 65536) throw new Error("Request exceeds 64 KiB.");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const expiresAt = expiration(now, BigInt(now / 1000 + 600), input.order.terms, input.service.maxRetentionSeconds);
  const keys = [input.order.buyer.publicKey, input.order.seller.publicKey, input.assignment.publicKey];
  const prepared = await prepareItem({
    plaintext,
    expiresAt,
    managers: [],
    recipientPublicKeys: keys,
    signer: input.signer
  });
  try {
    const reference: PreparedEvidence["record"] = {
      version: 2,
      order: input.order,
      assignment: input.assignment,
      serviceId: input.service.id,
      profile: prepared.item.keyDerivationProfile,
      preparedAt: new Date(now).toISOString(),
      expiresAt,
      creator: prepared.item.creator,
      envelopes: await Promise.all(keys.map(async key => encodeBase64(await sealSeed(prepared.item.seed, key)))),
      evidenceHash: commitment("payunlock-request-content-v2", content)
    };
    const record = {reference, index: input.index, participant: input.participant, advisoryDate: input.advisoryDate};
    const recordHash = requestHash(record);
    verifyRequest({record, content}, recordHash, input.order, input.availableSequences);
    if (!input.isCurrent()) throw new Error("Assignment/session changed.");
    return {record, content, recordHash, item: prepared.item};
  } finally {
    clearItemKeys(prepared.keys);
  }
}

export async function openRequest(input: {
  row: RequestRow;
  order: Order;
  role: "buyer" | "seller" | "arbitrator";
  privateKey: Uint8Array;
  service: Service;
  availableSequences: string[];
  isCurrent(): boolean
}): Promise<RequestOpening> {
  const record = requestRecord(input.row, input.order), r = record.reference;
  if (!input.isCurrent() || r.serviceId !== input.service.id || requestHash(record) !== input.row.commitment) throw new Error("Request reference mismatch.");
  const seed = await openSealedSeed(decodeBase64(r.envelopes[["buyer", "seller", "arbitrator"].indexOf(input.role)]!, 65), input.privateKey);
  const item = await input.service.client.downloadAndVerify(seed, r.creator);
  if (!input.isCurrent() || item.expiresAt !== r.expiresAt || item.managers.length) throw new Error("Request storage policy mismatch.");
  const opened = await decryptStorageItem(item, r.creator, input.privateKey);
  if (opened.expired || !input.isCurrent()) throw new Error("Request expired or session changed.");
  const result = {record, content: RequestContentSchema.parse(strictJson(opened.plaintext))};
  verifyRequest(result, input.row.commitment, input.order, input.availableSequences);
  return result;
}

export async function persistRequest(store: LocalStore, key: string, prepared: PreparedRequest, password: string, current: () => boolean) {
  const encrypted = await encryptWithPassword(canonical(prepared), password, {
    domain: "payunlock-request-draft-v2",
    id: key
  });
  if (!current()) throw new Error("Assignment/session changed.");
  await store.compareAndSwap(key, undefined, encrypted);
}

export async function restoreRequest(store: LocalStore, key: string, password: string): Promise<PreparedRequest> {
  const p = strictJson(await decryptWithPassword(await store.get(key), password, {
    domain: "payunlock-request-draft-v2",
    id: key
  })) as PreparedRequest;
  if (requestHash(p.record) !== p.recordHash || commitment("payunlock-request-content-v2", RequestContentSchema.parse(p.content)) !== p.record.reference.evidenceHash) throw new Error("Request recovery mismatch.");
  return p;
}
