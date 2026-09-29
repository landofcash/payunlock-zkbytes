import { getAddress } from "ethers";
import { z } from "zod";

export const PASSKEY_ACCOUNTS_KEY = "payunlock.passkey-accounts.v1";
export const PASSKEY_ACCOUNTS_EVENT = "payunlock:passkey-accounts-changed";
const AccountSchema = z.object({
  address: z.string().transform(value => getAddress(value)),
  credentialId: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
  rpId: z.string().min(1).max(253),
});
export type SavedPasskeyAccount = z.infer<typeof AccountSchema>;

// An optional, untrusted directory. Authentication never depends on this cache.
export function savedPasskeyAccounts(): SavedPasskeyAccount[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PASSKEY_ACCOUNTS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const accounts = new Map<string, SavedPasskeyAccount>();
    for (const entry of raw) {
      try {
        const account = AccountSchema.parse(entry);
        if (account.rpId === window.location.hostname) accounts.set(account.credentialId, account);
      } catch { /* Ignore corrupt entries without hiding the remaining accounts. */ }
    }
    return [...accounts.values()];
  } catch { return []; }
}

export function rememberPasskeyAccount(value: SavedPasskeyAccount): void {
  try {
    // Explicitly project public metadata; never serialize a session or secret.
    const account = AccountSchema.parse({ address: value.address, credentialId: value.credentialId, rpId: value.rpId });
    if (account.rpId !== window.location.hostname) return;
    const previous = savedPasskeyAccounts();
    const found = previous.find(entry => entry.credentialId === account.credentialId);
    if (found?.address === account.address) return;
    const next = [...previous.filter(entry => entry.credentialId !== account.credentialId), account];
    window.localStorage.setItem(PASSKEY_ACCOUNTS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(PASSKEY_ACCOUNTS_EVENT));
  } catch { /* Disabled/full storage must not prevent passkey sign-in. */ }
}
