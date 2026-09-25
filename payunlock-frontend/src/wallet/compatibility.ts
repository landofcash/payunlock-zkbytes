import {
  BYTE_LENGTHS,
  clearItemKeys,
  encodeBase32,
  randomBytes,
  createSeedSigningMessage,
  normalizeMasterSignature,
  normalizeAndVerifyMasterSignature,
  deriveItemKeys,
  type ItemKeyPair,
} from "@zkbytes/sdk";
import type { LabWalletSession } from "./types";
import { WalletError } from "./errors";

export async function checkCompatibility(
  session: LabWalletSession,
  isCurrent: () => boolean,
) {
  const seed = encodeBase32(randomBytes(BYTE_LENGTHS.seed));
  let first: ItemKeyPair | undefined;
  let second: ItemKeyPair | undefined;
  const signer = {
    address: session.address,
    async signMessage(message: string) {
      if (!isCurrent()) throw new WalletError("wrong-account");
      const signature = await session.signMessage(message);
      if (!isCurrent()) {
        if (signature instanceof Uint8Array) signature.fill(0);
        throw new WalletError("wrong-account");
      }
      return signature;
    },
  };
  async function signAndDerive() {
    const message = createSeedSigningMessage(seed);
    const supplied = await signer.signMessage(message);
    let normalized: Uint8Array | undefined;
    let verified: Uint8Array | undefined;
    try {
      try {
        normalized = normalizeMasterSignature(supplied);
      } catch {
        throw new WalletError("unsupported");
      }
      try {
        verified = normalizeAndVerifyMasterSignature(
          normalized,
          message,
          signer.address,
        );
      } catch {
        throw new WalletError("wrong-account");
      }
      return await deriveItemKeys(verified);
    } finally {
      normalized?.fill(0);
      verified?.fill(0);
      if (supplied instanceof Uint8Array) supplied.fill(0);
    }
  }
  try {
    first = await signAndDerive();
    second = await signAndDerive();
    return (
      first.signingPublicKey.every(
        (value, i) => value === second!.signingPublicKey[i],
      ) &&
      first.encryptionPublicKey.every(
        (value, i) => value === second!.encryptionPublicKey[i],
      )
    );
  } finally {
    if (first) clearItemKeys(first);
    if (second) clearItemKeys(second);
  }
}
