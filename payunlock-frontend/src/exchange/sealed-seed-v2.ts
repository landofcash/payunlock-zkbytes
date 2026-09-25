import {
  BYTE_LENGTHS,
  WRAPPING_ALGORITHM,
  decodeBase64,
  decodeSeed,
  decryptPayload,
  encodeBase32,
  encodeBase64,
  encryptPayload,
  randomBytes,
  unwrapAesKey,
  wrapAesKey,
  x25519PublicKeyFromPrivate,
} from "@zkbytes/sdk";
import {
  createReceiveCard,
  parseReceiveCard,
  serializeReceiveCard,
  type ReceiveCard,
} from "./receive-card";

// Legacy v2: version (1), context (16), HPKE-wrapped AES key (80), IV (12),
// encrypted 26-character seed plus GCM authentication tag (42).
const VERSION = 2;
const PACKAGE_BYTES = 151;
const KEY_CHARACTERS = 52;
const PACKAGE_CHARACTERS = 242;
export const SEALED_SEED_FRAGMENT_LENGTH =
  KEY_CHARACTERS + 1 + PACKAGE_CHARACTERS;
export type SealedSeed = { recipientPublicKey: string; encryptedSeed: string };

function invalid(): never {
  throw new Error("Invalid or unsupported sealed seed.");
}

// Encoding only; all encryption and authentication remain in the SDK.
function decodeBase32(value: string, length: number): Uint8Array {
  if (
    value.length !== Math.ceil((length * 8) / 5) ||
    !/^[a-z2-7]+$/u.test(value)
  )
    invalid();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = new Uint8Array(length);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >> bits) & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (offset !== length || accumulator !== 0 || encodeBase32(bytes) !== value)
    invalid();
  return bytes;
}

export function parseSealedSeedFragment(fragment: string): SealedSeed {
  const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (
    value.length !== SEALED_SEED_FRAGMENT_LENGTH ||
    value[KEY_CHARACTERS] !== "-"
  )
    invalid();
  const publicKey = encodeBase64(
    decodeBase32(value.slice(0, KEY_CHARACTERS), 32),
  );
  createReceiveCard(publicKey);
  const encryptedSeed = value.slice(KEY_CHARACTERS + 1);
  const bytes = decodeBase32(encryptedSeed, PACKAGE_BYTES);
  if (bytes[0] !== VERSION) invalid();
  return { recipientPublicKey: publicKey, encryptedSeed };
}

export function sealedSeedFragment(envelope: SealedSeed): string {
  const publicKey = createReceiveCard(envelope.recipientPublicKey).publicKey;
  const fragment = `${encodeBase32(decodeBase64(publicKey))}-${envelope.encryptedSeed}`;
  parseSealedSeedFragment(fragment);
  return fragment;
}

export async function sealSeed(
  seed: string,
  recipient: ReceiveCard,
): Promise<SealedSeed> {
  decodeSeed(seed);
  const card = parseReceiveCard(serializeReceiveCard(recipient));
  const context = randomBytes(BYTE_LENGTHS.seed);
  const aesKey = randomBytes(BYTE_LENGTHS.aesKey);
  try {
    const wrapped = await wrapAesKey(
      encodeBase32(context),
      card.publicKey,
      aesKey,
    );
    const { encryptedPayload } = await encryptPayload(seed, aesKey);
    const [iv, ciphertext] = encryptedPayload.split(":");
    const bytes = new Uint8Array(PACKAGE_BYTES);
    bytes[0] = VERSION;
    bytes.set(context, 1);
    bytes.set(
      decodeBase64(wrapped.encryptedKey, BYTE_LENGTHS.hpkeEnvelope),
      17,
    );
    if (!iv || !ciphertext) throw new Error("Invalid encrypted payload.");
    bytes.set(decodeBase64(iv, BYTE_LENGTHS.aesIv), 97);
    bytes.set(decodeBase64(ciphertext, 42), 109);
    return {
      recipientPublicKey: card.publicKey,
      encryptedSeed: encodeBase32(bytes),
    };
  } finally {
    aesKey.fill(0);
  }
}

export async function openSealedSeed(
  fragment: string,
  privateKey: Uint8Array,
): Promise<string> {
  let aesKey: Uint8Array | undefined;
  try {
    const envelope = parseSealedSeedFragment(fragment);
    if (
      encodeBase64(await x25519PublicKeyFromPrivate(privateKey)) !==
      envelope.recipientPublicKey
    )
      invalid();
    const bytes = decodeBase32(envelope.encryptedSeed, PACKAGE_BYTES);
    aesKey = await unwrapAesKey(
      encodeBase32(bytes.slice(1, 17)),
      {
        publicKey: envelope.recipientPublicKey,
        wrappingAlgorithm: WRAPPING_ALGORITHM,
        encryptedKey: encodeBase64(bytes.slice(17, 97)),
      },
      privateKey,
    );
    const seed = await decryptPayload(
      `${encodeBase64(bytes.slice(97, 109))}:${encodeBase64(bytes.slice(109))}`,
      aesKey,
    );
    decodeSeed(seed);
    return seed;
  } catch {
    throw new Error(
      "Cannot open this sealed seed. Check the receiving key and link.",
    );
  } finally {
    aesKey?.fill(0);
  }
}

export function sealedSeedLink(
  appOrigin: string,
  envelope: SealedSeed,
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
  return `${appOrigin}/open#${sealedSeedFragment(envelope)}`;
}
