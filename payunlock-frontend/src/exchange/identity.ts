import {
  clearItemKeys,
  deriveItemKeys,
  encodeBase64,
  normalizeAndVerifyMasterSignature,
} from "@zkbytes/sdk";
import type { LabWalletSession } from "@/wallet/types";
import { WalletError } from "@/wallet/errors";

export const IDENTITY_PROFILE = "zkbytes-message-lab-receiving-v1";
export type ReceivingIdentity = {
  label: string;
  publicKey: string;
  privateKey: Uint8Array;
};
export function validateLabel(label: string) {
  // Deliberately exact ASCII: no hidden trimming, case folding or Unicode normalization.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(label) ||
    /[^A-Za-z0-9 ._-]/.test(label) ||
    label.endsWith(" ")
  )
    throw new Error(
      "Use 1–64 letters, numbers, spaces, dots, underscores or hyphens; start with a letter or number and omit trailing spaces.",
    );
  return label;
}
export function identityMessage(address: string, label: string) {
  validateLabel(label);
  return [
    "zkbytes Message Lab receiving identity",
    `Profile: ${IDENTITY_PROFILE}`,
    `Account: ${address.toLowerCase()}`,
    `Label: ${JSON.stringify(label)}`,
    "Purpose: Restore my reusable receiving encryption key.",
    "Only sign this message in an application you trust. No transaction is requested.",
  ].join("\n");
}
export async function deriveIdentity(
  session: LabWalletSession,
  label: string,
  isCurrent: () => boolean,
): Promise<ReceivingIdentity> {
  const address = session.address;
  const message = identityMessage(address, label);
  if (!isCurrent()) throw new WalletError("wrong-account");
  const supplied = await session.signMessage(message);
  let verified: Uint8Array | undefined;
  try {
    if (!isCurrent()) throw new WalletError("wrong-account");
    verified = normalizeAndVerifyMasterSignature(supplied, message, address);
    const keys = await deriveItemKeys(verified);
    try {
      if (!isCurrent()) throw new WalletError("wrong-account");
      return {
        label,
        publicKey: encodeBase64(keys.encryptionPublicKey),
        privateKey: keys.encryptionPrivateKey.slice(),
      };
    } finally {
      clearItemKeys(keys);
    }
  } finally {
    verified?.fill(0);
    if (supplied instanceof Uint8Array) supplied.fill(0);
  }
}
