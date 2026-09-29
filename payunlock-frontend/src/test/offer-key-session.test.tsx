import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { encodeBase64, type ItemKeyPair } from "@zkbytes/sdk";
import { SessionProvider, useSession } from "../wallet/session-store";
import { newOfferReceivingContext } from "../commerce/protocol";
import type { LabWalletSession, WalletSessionEvent } from "../wallet/types";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), restore: vi.fn() }));
vi.mock("../commerce/protocol", async original => ({ ...(await original<typeof import("../commerce/protocol")>()), restoreReceivingKeys: mocks.restore }));
vi.mock("@/wallet/metamask-adapter", () => ({ metamaskAdapter: { connect: mocks.connect } }));
let state: ReturnType<typeof useSession>;
function Probe() { state = useSession(); return null; }
afterEach(() => vi.useRealTimers());
const deployment = { chainId: 10143 as const, contract: `0x${"12".repeat(20)}` };
const offerId = "58c2aa55-6962-4390-b90e-86f4a5144eb6";

it.each(["lock", "disconnect", "accountsChanged", "chainChanged", "pagehide", "expiry", "unmount"])("reuses one offer signature and clears both private keys on %s", async reason => {
  if (reason === "expiry") vi.useFakeTimers();
  const wallet = { address: `0x${"12".repeat(20)}` };
  const signMessage = vi.fn(async () => "0xsignature");
  let emit!: (event: WalletSessionEvent) => void;
  const session: LabWalletSession = { address: wallet.address, kind: "metamask", walletName: "MetaMask", transport: "managed", signMessage, disconnect: vi.fn(), subscribe(listener) { emit = listener; return () => {}; } };
  mocks.connect.mockResolvedValue(session);
  mocks.restore.mockImplementation(async (_context, signer) => {
    await signer.signMessage('offer-key-signature');
    return { signingPrivateKey: new Uint8Array(32).fill(1), signingPublicKey: new Uint8Array(32).fill(2), encryptionPrivateKey: new Uint8Array(32).fill(3), encryptionPublicKey: new Uint8Array(32).fill(4) };
  });
  const view = render(<SessionProvider><Probe /></SessionProvider>);
  await act(() => state.connectMetaMask());
  const context = newOfferReceivingContext(deployment, wallet.address, offerId);
  let retained!: ItemKeyPair;
  await act(() => state.runOfferKeysOperation(context, undefined, async keys => { retained = keys; }));
  await act(() => state.runOfferKeysOperation(context, encodeBase64(retained.encryptionPublicKey), async keys => { expect(keys).toBe(retained); }));
  expect(signMessage).toHaveBeenCalledOnce();
  await act(async () => {
    if (reason === "lock") state.lockIdentities();
    else if (reason === "disconnect") await state.disconnect();
    else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else if (reason === "unmount") view.unmount();
    else if (reason === "expiry") {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      vi.useRealTimers();
    } else emit(reason as WalletSessionEvent);
  });
  expect(retained.signingPrivateKey.every(b => b === 0)).toBe(true);
  expect(retained.encryptionPrivateKey.every(b => b === 0)).toBe(true);
  if (reason === "lock") {
    await act(() => state.runOfferKeysOperation(context, undefined, async keys => { expect(keys).not.toBe(retained); }));
    expect(signMessage).toHaveBeenCalledTimes(2);
  }
});

it("rejects a signature arriving after identity lock instead of caching it", async () => {
  const wallet = { address: `0x${"12".repeat(20)}` };
  let finish!: (value: string) => void;
  mocks.connect.mockResolvedValue({ address: wallet.address, kind: "metamask", walletName: "MetaMask", transport: "managed", signMessage: () => new Promise<string>(resolve => { finish = resolve; }), disconnect: vi.fn() });
  mocks.restore.mockImplementation(async (_context, signer) => {
    await signer.signMessage('offer-key-signature');
    return { signingPrivateKey: new Uint8Array(32).fill(1), signingPublicKey: new Uint8Array(32).fill(2), encryptionPrivateKey: new Uint8Array(32).fill(3), encryptionPublicKey: new Uint8Array(32).fill(4) };
  });
  render(<SessionProvider><Probe /></SessionProvider>);
  await act(() => state.connectMetaMask());
  const context = newOfferReceivingContext(deployment, wallet.address, offerId);
  const callback = vi.fn();
  let result!: Promise<unknown>;
  await act(async () => { result = state.runOfferKeysOperation(context, undefined, callback).catch(error => error); });
  act(() => state.lockIdentities());
  await act(async () => finish("0xsignature"));
  expect(await result).toBeInstanceOf(Error);
  expect(callback).not.toHaveBeenCalled();
});
