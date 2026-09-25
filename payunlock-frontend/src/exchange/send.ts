import {
  clearItemKeys,
  prepareItem,
  ZkbytesApiError,
  type MasterMessageSigner,
  type StorageItem,
  type ZkbytesClient,
  type ZkbytesReference,
} from "@zkbytes/sdk";
import { parseReceiveCard } from "./receive-card";
import { sealSeed, type SealedSeed } from "./sealed-seed";

export type Candidate = {
  item: StorageItem;
  reference: ZkbytesReference;
  envelope: SealedSeed;
};
export type UploadState =
  | "ready"
  | "active"
  | "pending"
  | "uncertain"
  | "rejected"
  | "not-found"
  | "deleted"
  | "expired";
export const MAX_MESSAGE_BYTES = 65536;
export async function prepareMessage(
  client: ZkbytesClient,
  plaintext: string,
  cardText: string,
  expiresAt: string,
  signer: MasterMessageSigner,
  isCurrent: () => boolean,
): Promise<Candidate> {
  if (
    !plaintext.trim() ||
    new TextEncoder().encode(plaintext).length > MAX_MESSAGE_BYTES
  )
    throw new Error("Enter a message up to 64 KiB.");
  const recipient = parseReceiveCard(cardText);
  if (
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  )
    throw new Error("Choose a future expiration.");
  const check = () => {
    if (!isCurrent()) throw new Error("Session changed.");
  };
  check();
  let suppliedBytes: Uint8Array | undefined;
  const prepared = await prepareItem({
    plaintext,
    expiresAt,
    recipientPublicKeys: [recipient.publicKey],
    signer: {
      address: signer.address,
      async signMessage(message) {
        check();
        const signature = await signer.signMessage(message);
        if (signature instanceof Uint8Array) suppliedBytes = signature;
        if (!isCurrent()) {
          if (signature instanceof Uint8Array) signature.fill(0);
          check();
        }
        return signature;
      },
    },
  }).finally(() => suppliedBytes?.fill(0));
  try {
    check();
    const reference = client.createReference(prepared.item);
    const envelope = await sealSeed(reference.seed, recipient);
    check();
    return { item: prepared.item, reference, envelope };
  } finally {
    clearItemKeys(prepared.keys);
  }
}
export async function uploadCandidate(
  client: ZkbytesClient,
  candidate: Candidate,
): Promise<UploadState> {
  if (Date.parse(candidate.reference.expiresAt) <= Date.now()) return "expired";
  try {
    const response = await client.upload(candidate.item);
    return "state" in response ? "pending" : "active";
  } catch (error) {
    // A timeout, malformed response or server failure cannot establish that nothing was stored.
    if (
      error instanceof ZkbytesApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      [
        "INVALID_REQUEST",
        "INVALID_ITEM_SIGNATURE",
        "RETENTION_NOT_ALLOWED",
        "PAYLOAD_TOO_LARGE",
        "RATE_LIMITED",
      ].includes(error.code)
    )
      return "rejected";
    return "uncertain";
  }
}
export async function recoverCandidate(
  client: ZkbytesClient,
  candidate: Candidate,
): Promise<UploadState> {
  const result = await client.recoverUpload(
    candidate.reference.seed,
    candidate.reference.expectedCreator,
  );
  if (
    result.outcome === "active" &&
    (result.item.itemSignature.value !== candidate.item.itemSignature.value ||
      result.item.expiresAt !== candidate.reference.expiresAt ||
      result.status.expiresAt !== candidate.reference.expiresAt)
  )
    throw new Error("Recovered item does not match the prepared message.");
  return result.outcome;
}
