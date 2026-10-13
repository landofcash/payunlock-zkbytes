import {parseStrictJson} from "@zkbytes/sdk";
import {IDENTITY_PROFILE, validateLabel} from "./identity";
import {createReceiveCard} from "./receive-card";
import type {WalletKind} from "@/wallet/types";

export const IDENTITY_STORAGE_KEY = "payunlock.identities.v1";
export const MAX_BACKUP_BYTES = 65536;
export type SavedIdentity = {
  walletAddress: string;
  walletKind: WalletKind;
  label: string;
  publicKey: string;
  profile: typeof IDENTITY_PROFILE;
};

function exact(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === fields.sort().join(",")
  );
}

export function identityId(
  value: Pick<SavedIdentity, "walletAddress" | "label">,
) {
  return `${value.walletAddress.toLowerCase()}:${value.label}`;
}

export function mergeIdentities(
  current: SavedIdentity[],
  incoming: SavedIdentity[],
) {
  const merged = new Map(current.map((value) => [identityId(value), value]));
  for (const value of incoming) {
    const existing = merged.get(identityId(value));
    if (existing && existing.publicKey !== value.publicKey)
      throw new Error(
        "A saved wallet and label has a different public key. Nothing was imported.",
      );
    merged.set(identityId(value), value);
  }
  if (merged.size > 100) throw new Error("Save at most 100 identities.");
  return [...merged.values()];
}

export function parseIdentityBackup(text: string): SavedIdentity[] {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
    throw new Error("Backup is too large.");
  const data = parseStrictJson(text);
  if (
    !exact(data, ["format", "version", "identities"]) ||
    data.format !== "zkbytes-identities" ||
    data.version !== 1 ||
    !Array.isArray(data.identities) ||
    data.identities.length > 100
  )
    throw new Error("Invalid or unsupported identity backup.");
  const result = data.identities.map((item): SavedIdentity => {
    if (
      !exact(item, [
        "walletAddress",
        "walletKind",
        "label",
        "publicKey",
        "profile",
      ]) ||
      typeof item.walletAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(item.walletAddress) ||
      !["metamask", "walletconnect", "fixture", "builtin"].includes(
        String(item.walletKind),
      ) ||
      typeof item.label !== "string" ||
      typeof item.publicKey !== "string" ||
      item.profile !== IDENTITY_PROFILE
    )
      throw new Error("Invalid identity record.");
    validateLabel(item.label);
    createReceiveCard(item.publicKey);
    return {
      walletAddress: item.walletAddress.toLowerCase(),
      walletKind: item.walletKind as WalletKind,
      label: item.label,
      publicKey: item.publicKey,
      profile: IDENTITY_PROFILE,
    };
  });
  return mergeIdentities([], result);
}

export function serializeIdentityBackup(identities: SavedIdentity[]) {
  const text = JSON.stringify(
    {format: "zkbytes-identities", version: 1, identities},
    null,
    2,
  );
  parseIdentityBackup(text);
  return text;
}

export function readSavedIdentities(): SavedIdentity[] {
  const text = localStorage.getItem(IDENTITY_STORAGE_KEY);
  return text === null ? [] : parseIdentityBackup(text);
}
