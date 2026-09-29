import { beforeEach, expect, it, vi } from "vitest";
import { PASSKEY_ACCOUNTS_KEY, rememberPasskeyAccount, savedPasskeyAccounts } from "@/wallet/saved-passkeys";
const account = { address: `0x${"11".repeat(20)}`, credentialId: "dGVzdA", rpId: window.location.hostname };
beforeEach(() => localStorage.clear());

it("stores only public account hints, deduplicates them, and tolerates damaged entries", () => {
  const sessionLike = { ...account, privateKey: "never store this", prfOutput: "nor this" };
  rememberPasskeyAccount(sessionLike); rememberPasskeyAccount(sessionLike);
  expect(JSON.parse(localStorage.getItem(PASSKEY_ACCOUNTS_KEY)!)).toEqual([account]);
  localStorage.setItem(PASSKEY_ACCOUNTS_KEY, JSON.stringify([null, { ...account, address: "broken" }, { ...account, rpId: "another.example" }, account]));
  expect(savedPasskeyAccounts()).toEqual([account]);
  localStorage.setItem(PASSKEY_ACCOUNTS_KEY, "invalid json");
  expect(savedPasskeyAccounts()).toEqual([]);
});

it("does not turn unavailable browser storage into a sign-in failure", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  try {
    expect(savedPasskeyAccounts()).toEqual([]);
    expect(() => rememberPasskeyAccount(account)).not.toThrow();
  } finally { read.mockRestore(); write.mockRestore(); }
});
