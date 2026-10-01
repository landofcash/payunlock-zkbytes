import { getAddress } from "ethers";

export const ACCOUNT_NAMES_KEY = "payunlock.account-names.v1";
export const ACCOUNT_NAMES_EVENT = "payunlock:account-names-changed";
export const ACCOUNT_NAME_MAX_LENGTH = 64;
export type AccountNames = Record<string, string>;
const key = (address: string) => getAddress(address).toLowerCase();

export function savedAccountNames(): AccountNames {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNT_NAMES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const names: AccountNames = {};
    for (const [address, name] of Object.entries(value)) {
      try {
        if (typeof name === "string" && name.trim() && name.trim().length <= ACCOUNT_NAME_MAX_LENGTH) names[key(address)] = name.trim();
      } catch { /* Ignore malformed metadata. */ }
    }
    return names;
  } catch { return {}; }
}

function persist(names: AccountNames) {
  localStorage.setItem(ACCOUNT_NAMES_KEY, JSON.stringify(names));
  window.dispatchEvent(new Event(ACCOUNT_NAMES_EVENT));
}

// Names are public browser-local metadata, separate from vaults and passkeys.
export function ensureAccountNames(addresses: string[]): AccountNames {
  const names = savedAccountNames();
  let next = 1;
  let changed = false;
  for (const address of addresses) {
    const account = key(address);
    if (!names[account]) {
      let name: string;
      do { name = `Account ${next++}`; } while (Object.values(names).includes(name));
      names[account] = name; changed = true;
    }
  }
  if (changed) {
    try { persist(names); } catch { /* Unavailable naming storage must not prevent sign-in. */ }
  }
  return names;
}

export function saveAccountName(address: string, input: string): AccountNames {
  const name = input.trim();
  if (!name || name.length > ACCOUNT_NAME_MAX_LENGTH) throw new Error(`Enter an account name between 1 and ${ACCOUNT_NAME_MAX_LENGTH} characters.`);
  const names = savedAccountNames();
  names[key(address)] = name;
  try { persist(names); } catch { throw new Error("Could not save the account name in this browser. Try again."); }
  return names;
}
