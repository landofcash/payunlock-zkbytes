import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError } from "@category-labs/mera";
import { computeAddress, getBytes, HDNodeWallet, Mnemonic } from "ethers";
import { createManagedSession, type Approval } from "./managed-session";
import { DERIVATION_PATH, type VaultSecret } from "./vault";
import { rememberPasskeyAccount, type SavedPasskeyAccount } from "./saved-passkeys";

class SavedPasskeyMismatch extends Error {
  constructor() { super("This passkey does not match the saved account. Use Sign in with passkey to recover without the saved entry."); }
}

// Recovery profile v1: Mera's immutable default salt, BIP-39 English (no
// passphrase), BIP-32 Ethereum path. Changing any of these changes the account.
export function derivePasskeySecret(output: Uint8Array): VaultSecret {
  try {
    if (output.length !== 32) throw new Error("Invalid passkey secret.");
    const mnemonic = Mnemonic.fromEntropy(output);
    const wallet = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_PATH);
    return { privateKey: wallet.privateKey, mnemonic: mnemonic.phrase, path: DERIVATION_PATH };
  } finally { output.fill(0); }
}

// Authenticator PRF support is only confirmed by a successful ceremony. Do not
// exclude security keys or cross-device sign-in using a platform-only probe.
export function canUsePasskeys() {
  return typeof window !== "undefined" && window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create && !!navigator.credentials?.get;
}
export function passkeyError(error: unknown) {
  if (error instanceof SavedPasskeyMismatch) return error.message;
  if (isMeraError(error) && error.code === "PRF_UNAVAILABLE") return "This passkey provider does not support wallet recovery. Try another provider, import a recovery backup, or create a password account. A passkey may have been saved, but no wallet was opened.";
  return "Passkey sign-in or creation was not completed. Try again, use another device, or import your recovery backup. No password account was created.";
}
export async function openPasskeySession(mode: "create" | "signin", approve: Approval, selected?: SavedPasskeyAccount) {
  const rpId = window.location.hostname;
  if (selected && (mode !== "signin" || selected.rpId !== rpId)) throw new SavedPasskeyMismatch();
  const result = mode === "create"
    ? await createPasskeyWithPrfOutput({ rp: { id: rpId, name: "PayUnlock" }, user: { name: "PayUnlock account", displayName: "PayUnlock account" } })
    : await getPasskeyPrfOutput({ rpId, ...(selected ? { credential: { credentialId: selected.credentialId } } : {}) }); // No selection: discover without local metadata.
  const secret = derivePasskeySecret(result.prfOutput);
  try {
    const address = computeAddress(secret.privateKey);
    if (selected && (result.credentialId !== selected.credentialId || address.toLowerCase() !== selected.address.toLowerCase())) throw new SavedPasskeyMismatch();
    const session = Object.assign(createManagedSession(getBytes(secret.privateKey), approve), {
      passkey: Object.freeze({ credentialId: result.credentialId, rpId }),
    });
    rememberPasskeyAccount({ address, credentialId: result.credentialId, rpId });
    return session;
  } finally { secret.privateKey = ""; secret.mnemonic = null; }
}

export async function exportPasskeySecret(passkey: { credentialId: string; rpId: string }, expectedAddress: string): Promise<VaultSecret> {
  const result = await getPasskeyPrfOutput({ rpId: passkey.rpId, credential: { credentialId: passkey.credentialId } });
  const secret = derivePasskeySecret(result.prfOutput);
  if (result.credentialId !== passkey.credentialId || HDNodeWallet.fromPhrase(secret.mnemonic!, undefined, DERIVATION_PATH).address.toLowerCase() !== expectedAddress.toLowerCase()) {
    secret.privateKey = ""; secret.mnemonic = null;
    throw new Error("The passkey does not match this wallet.");
  }
  return secret;
}
