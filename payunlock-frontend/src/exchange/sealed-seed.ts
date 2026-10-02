import {
  SEALED_SEED_BYTES,
  SEALED_SEED_VERSION,
  decodeBase64,
  encodeBase64,
  sealSeed as encryptSeed,
  openSealedSeed as decryptSeed,
  x25519PublicKeyFromPrivate,
} from "@zkbytes/sdk";
import {
  createReceiveCard,
  parseReceiveCard,
  serializeReceiveCard,
  type ReceiveCard,
} from "./receive-card";

export const SEALED_SEED_FRAGMENT_LENGTH = 87;
export const SEALED_SEED_WITH_KEY_LENGTH = 131;
export type SealedSeed = { recipientPublicKey?: string; encryptedSeed: string };

function invalid(): never {
  throw new Error("Invalid or unsupported sealed seed.");
}

function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64url(value: string, bytes: number): Uint8Array {
  if (
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    invalid();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = decodeBase64(
    base64 + "=".repeat((4 - (base64.length % 4)) % 4),
    bytes,
  );
  if (base64url(decoded) !== value) invalid();
  return decoded;
}

export function parseSealedSeedFragment(fragment: string): SealedSeed {
  const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (
    value.length !== SEALED_SEED_FRAGMENT_LENGTH &&
    value.length !== SEALED_SEED_WITH_KEY_LENGTH
  )
    invalid();
  const parts = value.split(".");
  let recipientPublicKey: string | undefined;
  let encryptedSeed: string;
  if (parts.length === 1) {
    encryptedSeed = parts[0]!;
  } else if (parts.length === 2) {
    recipientPublicKey = encodeBase64(decodeBase64url(parts[0]!, 32));
    createReceiveCard(recipientPublicKey);
    encryptedSeed = parts[1]!;
  } else invalid();
  const bytes = decodeBase64url(encryptedSeed, SEALED_SEED_BYTES);
  if (bytes[0] !== SEALED_SEED_VERSION) invalid();
  return recipientPublicKey
    ? { recipientPublicKey, encryptedSeed }
    : { encryptedSeed };
}

export function sealedSeedFragment(
  envelope: SealedSeed,
  includeRecipient = false,
): string {
  let fragment = envelope.encryptedSeed;
  if (includeRecipient) {
    if (!envelope.recipientPublicKey) invalid();
    const card = createReceiveCard(envelope.recipientPublicKey);
    fragment = `${base64url(decodeBase64(card.publicKey))}.${fragment}`;
  }
  parseSealedSeedFragment(fragment);
  return fragment;
}

export async function sealSeed(
  seed: string,
  recipient: ReceiveCard,
): Promise<SealedSeed> {
  const card = parseReceiveCard(serializeReceiveCard(recipient));
  return {
    recipientPublicKey: card.publicKey,
    encryptedSeed: base64url(await encryptSeed(seed, card.publicKey)),
  };
}

export async function openSealedSeed(
  fragment: string,
  privateKey: Uint8Array,
): Promise<string> {
  try {
    const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
    const envelope = parseSealedSeedFragment(value);
    if (
      envelope.recipientPublicKey &&
      encodeBase64(await x25519PublicKeyFromPrivate(privateKey)) !==
        envelope.recipientPublicKey
    )
      invalid();
    return await decryptSeed(
      decodeBase64url(envelope.encryptedSeed, SEALED_SEED_BYTES),
      privateKey,
    );
  } catch {
    throw new Error(
      "Cannot open this sealed seed. Check the receiving key and link.",
    );
  }
}

export function sealedSeedLink(
  appOrigin: string,
  envelope: SealedSeed,
  includeRecipient = false,
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
  return `${appOrigin}/open#${sealedSeedFragment(envelope, includeRecipient)}`;
}
