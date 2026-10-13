import {
  BYTE_LENGTHS,
  WRAPPING_ALGORITHM,
  ZkbytesClient,
  canonicalTimestamp,
  decodeBase64,
  decodeSeed,
  decryptPayload,
  encodeBase32,
  encodeBase64,
  encryptPayload,
  parseStrictJson,
  randomBytes,
  unwrapAesKey,
  validateSigningDescriptor,
  wrapAesKey,
  x25519PublicKeyFromPrivate,
  type ZkbytesReference,
} from "@zkbytes/sdk";
import {
  createReceiveCard,
  parseReceiveCard,
  serializeReceiveCard,
  type ReceiveCard,
} from "./receive-card";

export const SEALED_REFERENCE_PROFILE =
  "zkbytes-message-lab-sealed-reference-v1";
export const MAX_ENVELOPE_BYTES = 8192;
export const MAX_REFERENCE_BYTES = 4096;
export type SupportedOrigins = { apiOrigin: string; downloadOrigin: string };
type Header = {
  format: "zkbytes-sealed-reference";
  version: 1;
  profile: typeof SEALED_REFERENCE_PROFILE;
  context: string;
  recipientPublicKey: string;
};
export type SealedReference = Header & {
  encryptedKey: string;
  encryptedPayload: string;
};
const encoder = new TextEncoder();

function invalid(): never {
  throw new Error("Invalid or unsupported sealed reference.");
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    invalid();
  return value as Record<string, unknown>;
}

function bounded(text: string, limit: number) {
  if (text.length > limit || encoder.encode(text).length > limit) invalid();
}

export function validateReference(
  input: unknown,
  supported: SupportedOrigins,
): ZkbytesReference {
  const value = exact(input, [
    "version",
    "service",
    "apiOrigin",
    "downloadOrigin",
    "seed",
    "expiresAt",
    "expectedCreator",
  ]);
  if (
    value.version !== 1 ||
    value.service !== "zkbytes" ||
    typeof value.apiOrigin !== "string" ||
    typeof value.downloadOrigin !== "string" ||
    typeof value.seed !== "string" ||
    typeof value.expiresAt !== "string"
  )
    invalid();
  // Construction validates origins without making requests. Only this exact configured pair is allowed.
  const client = new ZkbytesClient(supported);
  if (
    value.apiOrigin !== client.apiOrigin ||
    value.downloadOrigin !== client.downloadOrigin
  )
    invalid();
  decodeSeed(value.seed);
  if (canonicalTimestamp(value.expiresAt) !== value.expiresAt) invalid();
  const creator = validateSigningDescriptor(value.expectedCreator);
  const reference: ZkbytesReference = {
    version: 1,
    service: "zkbytes",
    apiOrigin: value.apiOrigin,
    downloadOrigin: value.downloadOrigin,
    seed: value.seed,
    expiresAt: value.expiresAt,
    expectedCreator: creator,
  };
  bounded(JSON.stringify(reference), MAX_REFERENCE_BYTES);
  return reference;
}

function header(envelope: SealedReference): Header {
  return {
    format: envelope.format,
    version: envelope.version,
    profile: envelope.profile,
    context: envelope.context,
    recipientPublicKey: envelope.recipientPublicKey,
  };
}

export function parseSealedReference(text: string): SealedReference {
  bounded(text, MAX_ENVELOPE_BYTES);
  const value = exact(parseStrictJson(text), [
    "format",
    "version",
    "profile",
    "context",
    "recipientPublicKey",
    "encryptedKey",
    "encryptedPayload",
  ]);
  if (
    value.format !== "zkbytes-sealed-reference" ||
    value.version !== 1 ||
    value.profile !== SEALED_REFERENCE_PROFILE ||
    typeof value.context !== "string" ||
    typeof value.recipientPublicKey !== "string" ||
    typeof value.encryptedKey !== "string" ||
    typeof value.encryptedPayload !== "string"
  )
    invalid();
  decodeSeed(value.context);
  createReceiveCard(value.recipientPublicKey);
  decodeBase64(value.encryptedKey, BYTE_LENGTHS.hpkeEnvelope);
  const parts = value.encryptedPayload.split(":");
  if (parts.length !== 2) invalid();
  decodeBase64(parts[0]!, BYTE_LENGTHS.aesIv);
  const ciphertext = decodeBase64(parts[1]!);
  if (ciphertext.length < 16 || ciphertext.length > MAX_REFERENCE_BYTES + 1024)
    invalid();
  return value as SealedReference;
}

export async function sealReference(
  referenceInput: unknown,
  recipient: ReceiveCard,
  supported: SupportedOrigins,
): Promise<SealedReference> {
  const card = parseReceiveCard(serializeReceiveCard(recipient));
  const reference = validateReference(referenceInput, supported);
  const metadata: Header = {
    format: "zkbytes-sealed-reference",
    version: 1,
    profile: SEALED_REFERENCE_PROFILE,
    context: encodeBase32(randomBytes(BYTE_LENGTHS.seed)),
    recipientPublicKey: card.publicKey,
  };
  const aesKey = randomBytes(BYTE_LENGTHS.aesKey);
  try {
    // Authenticate all public metadata as part of the encrypted plaintext, then compare on open.
    const {encryptedPayload} = await encryptPayload(
      JSON.stringify({...metadata, reference}),
      aesKey,
    );
    const wrapped = await wrapAesKey(metadata.context, card.publicKey, aesKey);
    return parseSealedReference(
      JSON.stringify({
        ...metadata,
        encryptedKey: wrapped.encryptedKey,
        encryptedPayload,
      }),
    );
  } finally {
    aesKey.fill(0);
  }
}

export async function openSealedReference(
  text: string,
  privateKey: Uint8Array,
  supported: SupportedOrigins,
): Promise<ZkbytesReference> {
  let aesKey: Uint8Array | undefined;
  try {
    const envelope = parseSealedReference(text);
    if (
      encodeBase64(await x25519PublicKeyFromPrivate(privateKey)) !==
      envelope.recipientPublicKey
    )
      invalid();
    aesKey = await unwrapAesKey(
      envelope.context,
      {
        publicKey: envelope.recipientPublicKey,
        wrappingAlgorithm: WRAPPING_ALGORITHM,
        encryptedKey: envelope.encryptedKey,
      },
      privateKey,
    );
    const plaintext = await decryptPayload(envelope.encryptedPayload, aesKey);
    bounded(plaintext, MAX_REFERENCE_BYTES + 1024);
    const inner = exact(parseStrictJson(plaintext), [
      ...Object.keys(header(envelope)),
      "reference",
    ]);
    for (const [key, value] of Object.entries(header(envelope)))
      if (inner[key] !== value) invalid();
    return validateReference(inner.reference, supported);
  } catch {
    throw new Error(
      "Cannot open this sealed reference. Check the receiving key, supported destinations and envelope.",
    );
  } finally {
    aesKey?.fill(0);
  }
}

export function sealedReferenceLink(
  appOrigin: string,
  envelope: SealedReference,
): string {
  const origin = new URL(appOrigin);
  if (
    origin.origin !== appOrigin ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    invalid();
  const text = JSON.stringify(parseSealedReference(JSON.stringify(envelope)));
  const fragment = encodeBase64(encoder.encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${appOrigin}/open#${fragment}`;
}

export function parseSealedReferenceFragment(
  fragment: string,
): SealedReference {
  const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (
    !value ||
    value.length > Math.ceil((MAX_ENVELOPE_BYTES * 4) / 3) ||
    /[^A-Za-z0-9_-]/.test(value)
  )
    invalid();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = decodeBase64(
    base64 + "=".repeat((4 - (base64.length % 4)) % 4),
  );
  return parseSealedReference(
    new TextDecoder("utf-8", {fatal: true}).decode(bytes),
  );
}
