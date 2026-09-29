// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HDNodeWallet, Mnemonic } from "ethers";
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, MeraError } from "@category-labs/mera";
import { derivePasskeySecret, exportPasskeySecret, openPasskeySession, passkeyError } from "@/wallet/passkey";
import { WalletVault } from "@/wallet/vault";
import { IndexedStore } from "@/storage/local-store";
import { unlockWallet } from "@/wallet/managed-session";
import { newReceivingContext, restoreReceiving } from "@/commerce/protocol";

vi.mock("@category-labs/mera", async original => ({
  ...await original<typeof import("@category-labs/mera")>(),
  createPasskeyWithPrfOutput: vi.fn(), getPasskeyPrfOutput: vi.fn(),
}));
const entropy = () => new Uint8Array(32).fill(42);
const credentialId = "dGVzdC1jcmVkZW50aWFs";
beforeEach(() => {
  vi.stubGlobal("window", { location: { hostname: "payunlock.example" } });
  vi.mocked(createPasskeyWithPrfOutput).mockImplementation(async () => ({ credentialId, prfSalt: new Uint8Array(32), prfOutput: entropy() }));
  vi.mocked(getPasskeyPrfOutput).mockImplementation(async () => ({ credentialId, prfOutput: entropy() }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

it("recovers the same wallet and delivery keys with no browser storage or cached credential", async () => {
  const approve = vi.fn(async () => true);
  const created = await openPasskeySession("create", approve);
  const context = newReceivingContext({ chainId: 10143, contract: `0x${"a".repeat(40)}` }, created.address);
  const first = await restoreReceiving(context, created, () => true);
  const signature = await created.signMessage("recovery fixture");
  created.lock();
  const recovered = await openPasskeySession("signin", approve);
  try {
    expect(getPasskeyPrfOutput).toHaveBeenCalledWith({ rpId: "payunlock.example" });
    expect(recovered.address).toBe(created.address);
    expect(await recovered.signMessage("recovery fixture")).toBe(signature);
    const second = await restoreReceiving(context, recovered, () => true, first.publicKey);
    expect(second.privateKey).toEqual(first.privateKey);
    second.privateKey.fill(0);
  } finally { first.privateKey.fill(0); recovered.lock(); }
});

it("exports only after a credential-bound ceremony and imports phrase or key into the same password wallet", async () => {
  const session = await openPasskeySession("signin", async () => true);
  try {
    const backup = await exportPasskeySecret(session.passkey, session.address);
    expect(getPasskeyPrfOutput).toHaveBeenLastCalledWith({ rpId: "payunlock.example", credential: { credentialId } });
    // Independent standard BIP-39/BIP-32 reconstruction pins the recovery profile.
    const expected = HDNodeWallet.fromPhrase(Mnemonic.fromEntropy(entropy()).phrase);
    expect(session.address).toBe(expected.address);
    // Password vault events require a browser; use the Node-only vault here.
    vi.unstubAllGlobals();
    for (const input of [backup.mnemonic!, backup.privateKey]) {
      const vault = new WalletVault(new IndexedStore(`passkey-import-${crypto.randomUUID()}`));
      expect(await vault.import(input, "long recovery password")).toBe(session.address);
      const imported = await unlockWallet(vault, session.address, "long recovery password", async () => true);
      try { expect(await imported.signMessage("same wallet")).toBe(await session.signMessage("same wallet")); }
      finally { imported.lock(); }
    }
    backup.privateKey = ""; backup.mnemonic = null;
  } finally { session.lock(); }
});

it("clears PRF bytes, rejects an incorrect export credential and a changed derivation output", async () => {
  const output = entropy(); derivePasskeySecret(output); expect(output.every(byte => byte === 0)).toBe(true);
  const session = await openPasskeySession("signin", async () => true);
  try {
    vi.mocked(getPasskeyPrfOutput).mockResolvedValueOnce({ credentialId: "b3RoZXI", prfOutput: entropy() });
    await expect(exportPasskeySecret(session.passkey, session.address)).rejects.toThrow("does not match");
    const changed = new Uint8Array(32).fill(43);
    vi.mocked(getPasskeyPrfOutput).mockResolvedValueOnce({ credentialId, prfOutput: changed });
    await expect(exportPasskeySecret(session.passkey, session.address)).rejects.toThrow("does not match");
    expect(changed.every(byte => byte === 0)).toBe(true);
  } finally { session.lock(); }
});

it("keeps the five-minute limit and rejects signing after expiry", async () => {
  vi.useFakeTimers();
  const session = await openPasskeySession("signin", async () => true);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(session.locked).toBe(true);
  await expect(session.signMessage("expired")).rejects.toThrow("locked");
});

it("targets a saved credential and rejects a cached address or credential mismatch", async () => {
  const first = await openPasskeySession("signin", async () => true);
  const selected = { address: first.address, ...first.passkey };
  first.lock();
  const recovered = await openPasskeySession("signin", async () => true, selected);
  expect(getPasskeyPrfOutput).toHaveBeenLastCalledWith({ rpId: selected.rpId, credential: { credentialId } });
  expect(recovered.address).toBe(selected.address); recovered.lock();
  await expect(openPasskeySession("signin", async () => true, { ...selected, address: `0x${"11".repeat(20)}` })).rejects.toThrow("does not match");
  vi.mocked(getPasskeyPrfOutput).mockResolvedValueOnce({ credentialId: "b3RoZXI", prfOutput: entropy() });
  await expect(openPasskeySession("signin", async () => true, selected)).rejects.toThrow("does not match");
  await expect(openPasskeySession("signin", async () => true, { ...selected, rpId: "another.example" })).rejects.toThrow("does not match");
});

it("propagates cancellation and unsupported PRF without creating a password wallet", async () => {
  for (const code of ["PRF_UNAVAILABLE", "PASSKEY_OPERATION_FAILED"] as const) {
    const error = new MeraError(code, "test");
    vi.mocked(createPasskeyWithPrfOutput).mockRejectedValueOnce(error);
    await expect(openPasskeySession("create", async () => true)).rejects.toBe(error);
    expect(passkeyError(error)).toMatch(code === "PRF_UNAVAILABLE" ? /does not support/ : /not completed/);
  }
});
