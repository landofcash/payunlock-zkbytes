// @vitest-environment node
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { WalletVault } from "@/wallet/vault";
import { IndexedStore } from "@/storage/local-store";
import { unlockWallet } from "@/wallet/managed-session";
const password = "correct horse battery staple", replacement = "a different long passphrase";
const key = `0x${"0".repeat(63)}1`;
const fixture = () => { const store = new IndexedStore(`wallet-management-${crypto.randomUUID()}`); return { store, vault: new WalletVault(store) }; };
it("lists legacy address records and switches between private-key and mnemonic accounts", async () => {
  const { vault } = fixture(), first = await vault.import(key, password), second = await vault.create(password);
  expect(await vault.list()).toEqual([first, second].sort());
  expect((await vault.export(first, password)).mnemonic).toBeNull();
  const mnemonic = (await vault.export(second, password)).mnemonic;
  expect(mnemonic?.split(" ")).toHaveLength(12);
  const restored = fixture().vault; expect(await restored.import(mnemonic!, password)).toBe(second);
  await vault.select(first); expect(await vault.selected()).toBe(first);
  await expect(vault.select(`0x${"44".repeat(20)}`)).rejects.toThrow("not found");
});
it("changes only the local encryption passphrase and preserves signing identity and recovery journals", async () => {
  const { vault, store } = fixture(), address = await vault.import(key, password);
  await store.put("pending:order", { encrypted: "unchanged" });
  const original = await store.get(`wallet:${address}`);
  await expect(vault.changePassword(address, "incorrect", replacement)).rejects.toThrow();
  expect(await store.get(`wallet:${address}`)).toEqual(original);
  const session = await unlockWallet(vault, address, password, async () => true);
  const signed = await session.signMessage("identity fixture"); session.lock();
  await vault.changePassword(address, password, replacement);
  await expect(vault.export(address, password)).rejects.toThrow();
  expect((await vault.export(address, replacement)).privateKey).toBe(key);
  const restored = await unlockWallet(vault, address, replacement, async () => true);
  try { expect(await restored.signMessage("identity fixture")).toBe(signed); } finally { restored.lock(); }
  expect(await store.get("pending:order")).toEqual({ encrypted: "unchanged" });
});
it("requires the correct passphrase to remove a wallet and preserves other wallets and encrypted work", async () => {
  const { vault, store } = fixture(), first = await vault.import(key, password), second = await vault.create(password);
  await store.put("pending:order", { encrypted: "keep" });
  await vault.select(first);
  await expect(vault.remove(first, "incorrect")).rejects.toThrow(); expect(await vault.list()).toHaveLength(2);
  await vault.remove(first, password);
  expect(await vault.list()).toEqual([second]); expect(await vault.selected()).toBe(second);
  expect(await store.get(`wallet:${first}`)).toBeUndefined(); expect(await store.get("pending:order")).toEqual({ encrypted: "keep" });
  await vault.remove(second, password); expect(await vault.selected()).toBeNull(); expect(await vault.list()).toEqual([]);
});
it("rejects a stale passphrase rewrite if the encrypted vault changes in another tab", async () => {
  const { vault, store } = fixture(), address = await vault.import(key, password);
  const original = store.compareAndSwap.bind(store);
  vi.spyOn(store, "compareAndSwap").mockImplementationOnce(async (id, before, after) => { await store.put(id, { changed: true }); return original(id, before, after); });
  await expect(vault.changePassword(address, password, replacement)).rejects.toThrow("another tab");
  expect(await store.get(`wallet:${address}`)).toEqual({ changed: true });
});
