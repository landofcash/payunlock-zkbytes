import { beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT_NAMES_KEY, ensureAccountNames, savedAccountNames, saveAccountName } from "@/wallet/account-names";

const first = `0x${"11".repeat(20)}`, second = `0x${"22".repeat(20)}`, third = `0x${"33".repeat(20)}`;
beforeEach(() => localStorage.clear());

it("persists default names and keeps them through reordering, removal, and adding accounts", () => {
  expect(ensureAccountNames([first, second])).toMatchObject({ [first]: "Account 1", [second]: "Account 2" });
  expect(ensureAccountNames([second, first])).toMatchObject({ [first]: "Account 1", [second]: "Account 2" });
  expect(ensureAccountNames([second, third])).toMatchObject({ [second]: "Account 2", [third]: "Account 3" });
  expect(savedAccountNames()[first]).toBe("Account 1");
});

it("persists trimmed custom names by address and never overwrites them with defaults", () => {
  ensureAccountNames([first, second]);
  saveAccountName(first, "  Personal wallet  ");
  expect(ensureAccountNames([second, first])[first]).toBe("Personal wallet");
  expect(JSON.parse(localStorage.getItem(ACCOUNT_NAMES_KEY)!)).toEqual({ [first]: "Personal wallet", [second]: "Account 2" });
  expect(() => saveAccountName(first, " ")).toThrow("between 1 and 64");
  expect(() => saveAccountName(first, "x".repeat(65))).toThrow("between 1 and 64");
  expect(savedAccountNames()[first]).toBe("Personal wallet");
});

it("ignores corrupt metadata without losing valid names", () => {
  localStorage.setItem(ACCOUNT_NAMES_KEY, JSON.stringify({ [first]: "Personal", [second]: "", [third]: 7, broken: "Ignore" }));
  expect(savedAccountNames()).toEqual({ [first]: "Personal" });
  localStorage.setItem(ACCOUNT_NAMES_KEY, "bad json");
  expect(savedAccountNames()).toEqual({});
});

it("keeps accounts available when storage fails and reports a failed rename", () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  try {
    expect(ensureAccountNames([first])[first]).toBe("Account 1");
    expect(() => saveAccountName(first, "Personal")).toThrow("Could not save");
  } finally { write.mockRestore(); }
});
