import {
  BYTE_LENGTHS, KEY_DERIVATION_PROFILE, LIMITS, canonicalTimestamp,
  createItemSigningMessage, encodeBase32, encodeBase64, encryptPayload,
  randomBytes, signEd25519, signingDescriptor, validateStorageItem, wrapAesKey,
  type ItemKeyPair, type StorageItem,
} from "@zkbytes/sdk";

// The same wallet-derived offer keys sign multiple objects. Each object still
// has an independent locator, content key, AES-GCM nonce and HPKE encapsulations.
// Use public SDK primitives so the storage wire format remains unchanged.
export async function prepareOfferItem(input: {
  plaintext: string; expiresAt: string; keys: ItemKeyPair;
  buyerPublicKey: string; isCurrent(): boolean;
}): Promise<StorageItem> {
  const check = () => { if (!input.isCurrent()) throw new Error("Session changed."); };
  check();
  const expiresAt = canonicalTimestamp(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("Expiration must be in the future.");
  const seed = encodeBase32(randomBytes(BYTE_LENGTHS.seed));
  const aesKey = randomBytes(BYTE_LENGTHS.aesKey);
  try {
    const { encryptedPayload } = await encryptPayload(input.plaintext, aesKey);
    check();
    if (encryptedPayload.length > LIMITS.encryptedPayloadCharacters) throw new Error("Encrypted payload exceeds the protocol limit.");
    const recipients = [...new Set([input.buyerPublicKey, encodeBase64(input.keys.encryptionPublicKey)])];
    const encryptedKeys = await Promise.all(recipients.map(key => wrapAesKey(seed, key, aesKey)));
    check();
    const item: StorageItem = {
      version: 1, seed, expiresAt, encryptedPayload, encryptedKeys,
      creator: signingDescriptor(input.keys.signingPublicKey), managers: [],
      keyDerivationProfile: KEY_DERIVATION_PROFILE, itemSignature: { value: "" },
    };
    item.itemSignature.value = signEd25519(createItemSigningMessage(item), input.keys.signingPrivateKey);
    return validateStorageItem(item);
  } finally { aesKey.fill(0); }
}
