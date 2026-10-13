import {
  decodeBase64,
  encodeBase64,
  validateX25519PublicKey,
  normalizeAndVerifyMasterSignature,
  type MasterMessageSigner,
} from "@zkbytes/sdk";
import {IDENTITY_PROFILE} from "./identity";

export type ReceiveCard = {
  format: "zkbytes-receive-card";
  version: 1;
  profile: typeof IDENTITY_PROFILE;
  algorithm: "X25519";
  publicKey: string;
  endorsement?: { walletAddress: string; signature: string };
};

function base64url(bytes: Uint8Array) {
  return encodeBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeUrl(text: string, length: number) {
  if (
    !/^[A-Za-z0-9_-]+$/.test(text) ||
    text.length !== Math.ceil((length * 4) / 3)
  )
    throw new Error("Invalid encoding.");
  const bytes = decodeBase64(
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4),
    length,
  );
  if (base64url(bytes) !== text) throw new Error("Noncanonical encoding.");
  return bytes;
}

export function receiveCardMessage(publicKey: string) {
  const card = createReceiveCard(publicKey);
  return `zkbytes Receive card\nVersion: 1\nPublic key: ${base64url(decodeBase64(card.publicKey))}`;
}

function verifyEndorsement(card: ReceiveCard) {
  if (!card.endorsement) return;
  const {walletAddress, signature} = card.endorsement;
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress))
    throw new Error("Invalid wallet address.");
  const bytes = decodeUrl(signature, 65);
  const verified = normalizeAndVerifyMasterSignature(
    bytes,
    receiveCardMessage(card.publicKey),
    walletAddress,
  );
  try {
    if (base64url(verified) !== signature)
      throw new Error("Noncanonical signature.");
  } finally {
    bytes.fill(0);
    verified.fill(0);
  }
}

export function serializeReceiveCard(card: ReceiveCard): string {
  const valid = createReceiveCard(card.publicKey);
  verifyEndorsement(card);
  const prefix = `zkbytes.v1.${base64url(decodeBase64(valid.publicKey))}`;
  return card.endorsement
    ? `${prefix}.${card.endorsement.walletAddress.toLowerCase()}.${card.endorsement.signature}`
    : prefix;
}

export function receiveLink(origin: string, card: ReceiveCard): string {
  return new URL(`/send#${serializeReceiveCard(card)}`, origin).href;
}

export async function signReceiveCard(
  publicKey: string,
  signer: MasterMessageSigner,
  isCurrent: () => boolean,
): Promise<ReceiveCard> {
  const card = createReceiveCard(publicKey);
  if (!isCurrent()) throw new Error("Session changed.");
  const message = receiveCardMessage(publicKey);
  const address = signer.address;
  const supplied = await signer.signMessage(message);
  let verified: Uint8Array | undefined;
  try {
    if (!isCurrent()) throw new Error("Session changed.");
    verified = normalizeAndVerifyMasterSignature(supplied, message, address);
    card.endorsement = {
      walletAddress: address.toLowerCase(),
      signature: base64url(verified),
    };
    return card;
  } finally {
    verified?.fill(0);
    if (supplied instanceof Uint8Array) supplied.fill(0);
  }
}

export function createReceiveCard(publicKey: string): ReceiveCard {
  const key = decodeBase64(publicKey);
  validateX25519PublicKey(key);
  if (key.every((byte) => byte === 0)) throw new Error("Invalid public key.");
  if (encodeBase64(key) !== publicKey)
    throw new Error("Noncanonical public key.");
  return {
    format: "zkbytes-receive-card",
    version: 1,
    profile: IDENTITY_PROFILE,
    algorithm: "X25519",
    publicKey,
  };
}

export function parseReceiveCard(text: string): ReceiveCard {
  if (new TextEncoder().encode(text).length > 2048)
    throw new Error("Receive link is too large.");
  text = text.trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.pathname !== "/send" || url.search || url.username || url.password)
      throw new Error("Invalid Receive link.");
    text = url.hash.slice(1);
  }
  if (text.startsWith("zkbytes.")) {
    const parts = text.split(".");
    if ((parts.length !== 3 && parts.length !== 5) || parts[1] !== "v1")
      throw new Error("Unsupported Receive link.");
    const card = createReceiveCard(encodeBase64(decodeUrl(parts[2]!, 32)));
    if (parts.length === 5) {
      card.endorsement = {
        walletAddress: parts[3]!.toLowerCase(),
        signature: parts[4]!,
      };
      verifyEndorsement(card);
    }
    return card;
  }
  throw new Error(
    "Unsupported Receive link. Paste a Receive link or zkbytes.v1 compact text.",
  );
}
