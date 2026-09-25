import {
  decryptStorageItem,
  ZkbytesError,
  type ZkbytesClient,
  type ZkbytesReference,
} from "@zkbytes/sdk";
import { openSealedSeed } from "./sealed-seed";
import {
  openSealedReference,
  parseSealedReferenceFragment,
} from "./sealed-reference";

export type OpenedMessage = {
  plaintext: string;
  expiresAt: string;
  expired: boolean;
};

export async function openMessage(
  input: string,
  privateKey: Uint8Array,
  client: ZkbytesClient,
  isCurrent: () => boolean,
): Promise<OpenedMessage> {
  const check = () => {
    if (!isCurrent()) throw new Error("Operation cancelled.");
  };
  check();
  if (input.length > 12000) throw new Error("Invalid sealed link.");
  let fragment = input.trim();
  if (/^https?:\/\//i.test(fragment)) fragment = new URL(fragment).hash;
  fragment = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  let seed: string;
  let reference: ZkbytesReference | undefined;
  if ([87, 131, 295].includes(fragment.length)) {
    seed = await openSealedSeed(fragment, privateKey);
  } else {
    // Preserve creator pinning and origin validation for older full-reference links.
    const envelope = fragment.startsWith("{")
      ? fragment
      : JSON.stringify(parseSealedReferenceFragment(fragment));
    reference = await openSealedReference(envelope, privateKey, client);
    seed = reference.seed;
  }
  check();
  const item = reference
    ? await client.downloadAndVerify(seed, reference.expectedCreator)
    : await client.download(seed);
  check();
  if (reference && item.expiresAt !== reference.expiresAt)
    throw new ZkbytesError(
      "INVALID_RESPONSE",
      "The item does not match the reference.",
    );
  const result = await decryptStorageItem(
    item,
    reference?.expectedCreator ?? item.creator,
    privateKey,
  );
  check();
  return {
    plaintext: result.plaintext,
    expired: result.expired,
    expiresAt: item.expiresAt,
  };
}

export function openMessageError(error: unknown): string {
  if (error instanceof ZkbytesError) {
    if (error.code === "NETWORK_ERROR")
      return "The encrypted message could not be downloaded. It may be unavailable, expired, or the connection may have failed.";
    if (
      error.code === "INVALID_SIGNATURE" ||
      error.code === "INVALID_ITEM" ||
      error.code === "INVALID_RESPONSE"
    )
      return "Message verification failed. No plaintext was displayed.";
    if (error.code === "DECRYPTION_FAILED")
      return "Message decryption failed. Check the receiving identity and try again.";
  }
  return "Cannot open this link. Check the link and select its matching receiving identity.";
}
