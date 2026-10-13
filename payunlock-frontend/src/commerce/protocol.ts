import {z} from "zod";
import type {ItemKeyPair} from "@zkbytes/sdk";
import {
  canonicalTimestamp,
  clearItemKeys,
  decodeBase64,
  decryptStorageItem,
  deriveItemKeys,
  encodeBase64,
  KEY_DERIVATION_PROFILE,
  type MasterMessageSigner,
  normalizeAndVerifyMasterSignature,
  openSealedSeed,
  prepareItem,
  randomBytes,
  sealSeed,
  type StorageItem,
  validateSigningDescriptor,
  validateX25519PublicKey,
  type ZkbytesClient
} from "@zkbytes/sdk";
import {canonical, commitment, strictJson, utf8} from "@/crypto/encoding";
import {prepareOfferItem} from "./offer-item";

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(x => BigInt(x) < 2n ** 256n);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const key = z.string().refine(x => {
  try {
    validateX25519PublicKey(decodeBase64(x, 32));
    return true;
  } catch {
    return false;
  }
});
export const DeploymentSchema = z.strictObject({chainId: z.literal(10143), contract: address});
export const ReceivingContextSchema = z.strictObject({
  version: z.literal(1),
  deployment: DeploymentSchema,
  account: address,
  nonce: hash
});
export type ReceivingContext = z.infer<typeof ReceivingContextSchema>;
export const RecipientSchema = z.strictObject({context: ReceivingContextSchema, publicKey: key});
export const TermsSchema = z.strictObject({
  version: z.literal(1),
  token: address,
  price: uint,
  eventEnd: uint.nullable(),
  reviewWindow: uint,
  responseWindow: uint.refine(x => BigInt(x) > 0n)
});
export const OrderSchema = z.strictObject({
  deployment: DeploymentSchema,
  orderId: uint,
  buyer: RecipientSchema,
  seller: RecipientSchema,
  terms: TermsSchema
});
export type Order = z.infer<typeof OrderSchema>;
export const PayloadSchema = z.strictObject({
  text: z.string().max(65536),
  tickets: z.array(z.strictObject({row: uint, ticket: z.string().min(1).max(1024)})).max(100)
});
export const OpeningSchema = z.strictObject({
  version: z.literal(1),
  order: OrderSchema,
  kind: z.enum(["delivery", "message", "evidence"]),
  sender: address,
  turn: uint,
  salt: hash,
  payload: PayloadSchema
});
export type Opening = z.infer<typeof OpeningSchema>;
// Let the SDK validate its exact creator scheme and canonical public-key encoding.
const DescriptorSchema = z.unknown().transform(value => validateSigningDescriptor(value));
export const RecordSchema = z.strictObject({
  version: z.literal(2),
  order: OrderSchema,
  kind: OpeningSchema.shape.kind,
  sender: address,
  turn: uint,
  serviceId: z.number().int().min(1).max(4294967295),
  profile: z.literal(KEY_DERIVATION_PROFILE),
  preparedAt: z.string(),
  expiresAt: z.string(),
  creator: DescriptorSchema,
  buyerEnvelope: z.string(),
  sellerEnvelope: z.string(),
  contentHash: hash
});
export type DeliveryRecord = z.infer<typeof RecordSchema>;
export type PreparedDelivery = { record: DeliveryRecord; recordHash: string; item: StorageItem; opening: Opening };
export type Service = { id: number; client: ZkbytesClient; maxRetentionSeconds: number };
export const RETENTION_SECONDS = 365 * 24 * 60 * 60;

export function newReceivingContext(deployment: Order["deployment"], account: string): ReceivingContext {
  return ReceivingContextSchema.parse({
    version: 1,
    deployment,
    account: account.toLowerCase(),
    nonce: `0x${Array.from(randomBytes(32), x => x.toString(16).padStart(2, "0")).join("")}`
  });
}

// Encode the catalog UUID in the contract's receiving nonce field.
export function newOfferReceivingContext(deployment: Order["deployment"], account: string, offerId: string): ReceivingContext {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(offerId)) throw new Error("Invalid offer ID.");
  return ReceivingContextSchema.parse({
    version: 1,
    deployment,
    account: account.toLowerCase(),
    nonce: `0x${offerId.replaceAll("-", "").toLowerCase().padStart(64, "0")}`
  });
}

export function receivingMessage(context: ReceivingContext) {
  return `PayUnlock receiving identity v1\n${canonical(ReceivingContextSchema.parse(context))}\nRestore my encryption key. No transaction is requested.`;
}

export async function restoreReceivingKeys(context: ReceivingContext, signer: MasterMessageSigner & {
  signReceivingIdentity?(message: string): Promise<string>
}, isCurrent: () => boolean, expectedPublicKey?: string): Promise<ItemKeyPair> {
  const parsed = ReceivingContextSchema.parse(context);
  if (signer.address.toLowerCase() !== parsed.account || !isCurrent()) throw new Error("Wrong receiving account or session.");
  const message = receivingMessage(parsed),
    supplied = await (signer.signReceivingIdentity ? signer.signReceivingIdentity(message) : signer.signMessage(message));
  let verified: Uint8Array | undefined;
  try {
    if (!isCurrent()) throw new Error("Session changed.");
    verified = normalizeAndVerifyMasterSignature(supplied, message, parsed.account);
    const keys = await deriveItemKeys(verified);
    try {
      const publicKey = encodeBase64(keys.encryptionPublicKey);
      if (!isCurrent() || (expectedPublicKey && expectedPublicKey !== publicKey)) throw new Error("Restored receiving key does not match the order.");
      return keys;
    } catch (error) {
      clearItemKeys(keys);
      throw error;
    }
  } finally {
    verified?.fill(0);
    if (supplied instanceof Uint8Array) supplied.fill(0);
  }
}

export async function restoreReceiving(context: ReceivingContext, signer: MasterMessageSigner, isCurrent: () => boolean, expectedPublicKey?: string) {
  const keys = await restoreReceivingKeys(context, signer, isCurrent, expectedPublicKey);
  try {
    return {
      context: ReceivingContextSchema.parse(context),
      publicKey: encodeBase64(keys.encryptionPublicKey),
      privateKey: keys.encryptionPrivateKey.slice()
    };
  } finally {
    clearItemKeys(keys);
  }
}

export const termsHash = (terms: Order["terms"]) => commitment("payunlock-terms-v1", TermsSchema.parse(terms));
export const contentHash = (opening: Opening) => commitment("payunlock-content-v1", OpeningSchema.parse(opening));
export const recordHash = (record: DeliveryRecord) => commitment("payunlock-record-v2", RecordSchema.parse(record));

function validateOrder(input: Order) {
  const order = OrderSchema.parse(input);
  for (const recipient of [order.buyer, order.seller]) {
    if (canonical(recipient.context.deployment) !== canonical(order.deployment)) throw new Error("Receiving context deployment mismatch.");
  }
  return order;
}

export function expiration(preparedAt: number, latestPublicationSeconds: bigint, terms: Order["terms"], cap: number) {
  if (!Number.isSafeInteger(preparedAt) || !Number.isSafeInteger(cap) || cap < 0) throw new Error("Invalid retention policy.");
  if (cap !== 0 && cap < RETENTION_SECONDS) throw new Error("Storage retention cap is shorter than one year.");
  const expires = preparedAt + RETENTION_SECONDS * 1000;
  const reviewStart = BigInt(terms.eventEnd ?? "0") > latestPublicationSeconds ? BigInt(terms.eventEnd!) : latestPublicationSeconds;
  if (latestPublicationSeconds < BigInt(Math.floor(preparedAt / 1000)) || reviewStart + BigInt(terms.reviewWindow) >= BigInt(Math.floor(expires / 1000))) throw new Error("Known delivery/review window exceeds evidence retention.");
  return canonicalTimestamp(new Date(expires));
}

export async function prepareDelivery(input: {
  order: Order;
  payload: Opening["payload"];
  kind?: Opening["kind"];
  turn?: string;
  signer: MasterMessageSigner;
  service: Service;
  latestPublicationSeconds: bigint;
  isCurrent: () => boolean;
  now?: number;
  offerKeys?: ItemKeyPair
}): Promise<PreparedDelivery> {
  const order = validateOrder(input.order), now = Math.floor((input.now ?? Date.now()) / 1000) * 1000;
  const sender = input.signer.address.toLowerCase(), kind = input.kind ?? "delivery";
  if (sender !== order.seller.context.account && (kind === "delivery" || sender !== order.buyer.context.account)) throw new Error("Wrong sender.");
  const opening = OpeningSchema.parse({
    version: 1,
    order,
    kind,
    sender,
    turn: input.turn ?? "0",
    salt: `0x${Array.from(randomBytes(32), x => x.toString(16).padStart(2, "0")).join("")}`,
    payload: input.payload
  });
  const plaintext = canonical(opening);
  if (utf8(plaintext).length > 65536) throw new Error("Complete private record exceeds 64 KiB.");
  const expiresAt = expiration(now, input.latestPublicationSeconds, order.terms, input.service.maxRetentionSeconds);
  const check = () => {
    if (!input.isCurrent()) throw new Error("Session changed.");
  };
  check();
  if (input.offerKeys && kind !== "delivery") throw new Error("Offer keys are only supported for seller deliveries.");
  const offerKeys = kind === "delivery" ? input.offerKeys ?? await restoreReceivingKeys(order.seller.context, input.signer, input.isCurrent, order.seller.publicKey) : undefined;
  let prepared: { item: StorageItem; keys?: ItemKeyPair } | undefined;
  try {
    if (offerKeys && encodeBase64(offerKeys.encryptionPublicKey) !== order.seller.publicKey) throw new Error("Offer key does not match the purchased seller identity.");
    prepared = offerKeys
      ? {
        item: await prepareOfferItem({
          plaintext,
          expiresAt,
          keys: offerKeys,
          buyerPublicKey: order.buyer.publicKey,
          isCurrent: input.isCurrent
        })
      }
      : await prepareItem({
        plaintext,
        expiresAt,
        managers: [],
        recipientPublicKeys: [order.buyer.publicKey, order.seller.publicKey],
        signer: {
          address: sender, async signMessage(message) {
            check();
            const signature = await input.signer.signMessage(message);
            if (!input.isCurrent()) {
              if (signature instanceof Uint8Array) signature.fill(0);
              check();
            }
            return signature;
          }
        }
      });
    check();
    const record = RecordSchema.parse({
      version: 2,
      order,
      kind,
      sender,
      turn: opening.turn,
      serviceId: input.service.id,
      profile: KEY_DERIVATION_PROFILE,
      preparedAt: new Date(now).toISOString(),
      expiresAt,
      creator: prepared.item.creator,
      buyerEnvelope: encodeBase64(await sealSeed(prepared.item.seed, order.buyer.publicKey)),
      sellerEnvelope: encodeBase64(await sealSeed(prepared.item.seed, order.seller.publicKey)),
      contentHash: contentHash(opening)
    });
    check();
    return {record, recordHash: recordHash(record), item: prepared.item, opening};
  } finally {
    if (prepared?.keys) clearItemKeys(prepared.keys);
    if (offerKeys && !input.offerKeys) clearItemKeys(offerKeys);
  }
}

export async function openDelivery(input: {
  record: DeliveryRecord;
  expectedRecordHash: string;
  order: Order;
  role: "buyer" | "seller";
  privateKey: Uint8Array;
  services: readonly Service[];
  isCurrent: () => boolean
}): Promise<Opening> {
  const record = RecordSchema.parse(input.record);
  const check = () => {
    if (!input.isCurrent()) throw new Error("Session changed.");
  };
  check();
  validateOrder(input.order);
  if (recordHash(record) !== input.expectedRecordHash || canonical(record.order) !== canonical(input.order)) throw new Error("Delivery commitment/order mismatch.");
  const preparedAt = Date.parse(record.preparedAt);
  if (!Number.isFinite(preparedAt) || canonicalTimestamp(new Date(preparedAt + RETENTION_SECONDS * 1000)) !== record.expiresAt) throw new Error("Evidence retention policy mismatch.");
  const service = input.services.find(value => value.id === record.serviceId);
  if (!service) throw new Error("Unknown storage service/profile.");
  if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) throw new Error("Evidence expired; wallet recovery cannot restore it.");
  const seed = await openSealedSeed(decodeBase64(input.role === "buyer" ? record.buyerEnvelope : record.sellerEnvelope, 65), input.privateKey);
  check();
  const item = await service.client.downloadAndVerify(seed, record.creator);
  check();
  if (item.expiresAt !== record.expiresAt || item.managers.length !== 0) throw new Error("Evidence policy mismatch.");
  const result = await decryptStorageItem(item, record.creator, input.privateKey);
  check();
  const opening = OpeningSchema.parse(strictJson(result.plaintext));
  if (result.expired || contentHash(opening) !== record.contentHash || canonical(opening.order) !== canonical(input.order) || opening.kind !== record.kind || opening.sender !== record.sender || opening.turn !== record.turn) throw new Error("Private content commitment mismatch.");
  return opening;
}

export function publishEligibility(record: PreparedDelivery, state: {
  finalizedSuccessfulTx1: boolean;
  canceled: boolean;
  deadline: bigint;
  chainTime: bigint
}) {
  if (!state.finalizedSuccessfulTx1 || recordHash(record.record) !== record.recordHash) throw new Error("Successful finalized TX1 is required.");
  if (state.canceled || state.chainTime >= state.deadline) throw new Error("Publication is permanently unavailable; check refund eligibility.");
}
