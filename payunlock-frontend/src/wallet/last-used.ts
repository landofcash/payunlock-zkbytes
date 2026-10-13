import {getAddress} from "ethers";
import type {LabWalletSession} from "./types";

export const LAST_USED_KEY = "payunlock.last-used-account.v1";
export const LAST_USED_EVENT = "payunlock:last-used-account-changed";
export type LastUsedAccount = {
  address: string;
  kind: "password" | "passkey" | "metamask" | "walletconnect";
  credentialId?: string;
  rpId?: string;
};

// This is display metadata only. It never grants access or selects a signer.
export function readLastUsedAccount(): LastUsedAccount | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.address !== "string" || !["password", "passkey", "metamask", "walletconnect"].includes(String(record.kind))) return null;
    const address = getAddress(record.address);
    if (record.kind === "passkey") {
      if (typeof record.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(record.credentialId) || record.rpId !== location.hostname) return null;
      return {address, kind: "passkey", credentialId: record.credentialId, rpId: record.rpId};
    }
    return {address, kind: record.kind as LastUsedAccount["kind"]};
  } catch {
    return null;
  }
}

export function rememberLastUsedAccount(session: LabWalletSession): LastUsedAccount | null {
  if (session.kind === "fixture") return null;
  const value: LastUsedAccount = {
    address: getAddress(session.address),
    kind: session.kind === "builtin" ? (session.passkey ? "passkey" : "password") : session.kind === "metamask" ? "metamask" : "walletconnect",
    ...(session.passkey ? {credentialId: session.passkey.credentialId, rpId: session.passkey.rpId} : {}),
  };
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(value));
    window.dispatchEvent(new Event(LAST_USED_EVENT));
  } catch { /* Storage is optional. */
  }
  return value;
}

export function forgetLastUsedAccount(): void {
  try {
    localStorage.removeItem(LAST_USED_KEY);
    window.dispatchEvent(new Event(LAST_USED_EVENT));
  } catch { /* Storage is optional. */
  }
}
