// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createWalletConnectAdapter,
  type WalletConnectKit,
} from "@/wallet/walletconnect-adapter";
import { readReownProjectId } from "@/config/reown";

const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
function setup() {
  const accountListeners = new Set<(value: unknown) => void>();
  const providerListeners = new Set<() => void>();
  const stateListeners = new Set<(value: { open: boolean }) => void>();
  const networkListeners = new Set<() => void>();
  let account: { address?: string; isConnected: boolean } = {
    isConnected: false,
  };
  let chain = 10143;
  let present = false;
  const request = vi.fn(
    async ({
      method,
    }: {
      method: string;
      params?: unknown[];
    }): Promise<unknown> =>
      method === "eth_accounts" ? [account.address] : "0xsigned",
  );
  const provider = { request };
  const kit = {
    ready: vi.fn(async () => {}),
    open: vi.fn(async () => {
      stateListeners.forEach((fn) => fn({ open: true }));
    }),
    close: vi.fn(async () => {
      stateListeners.forEach((fn) => fn({ open: false }));
    }),
    disconnect: vi.fn(async () => {
      account = { isConnected: false };
      present = false;
      accountListeners.forEach((fn) => fn(account));
    }),
    resetWalletConnectUri: vi.fn(),
    resetConnectingWallet: vi.fn(),
    getAccount: () => account,
    getProvider: () => (present ? provider : undefined),
    getProviderType: () => "WALLET_CONNECT",
    getChainId: () => chain,
    getWalletInfo: () => ({ name: "Example Wallet" }),
    switchNetwork: vi.fn(async () => {}),
    subscribeAccount: (fn: (value: unknown) => void) => {
      accountListeners.add(fn);
      return () => accountListeners.delete(fn);
    },
    subscribeProviders: (fn: () => void) => {
      providerListeners.add(fn);
      return () => providerListeners.delete(fn);
    },
    subscribeState: (fn: (value: { open: boolean }) => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    subscribeNetwork: (fn: () => void) => {
      networkListeners.add(fn);
      return () => networkListeners.delete(fn);
    },
  };
  const adapter = createWalletConnectAdapter(
    async () => kit as unknown as WalletConnectKit,
  );
  return {
    kit,
    adapter,
    request,
    accountListeners,
    providerListeners,
    stateListeners,
    account(next = address) {
      account = { address: next, isConnected: true };
      accountListeners.forEach((fn) => fn(account));
    },
    provider() {
      present = true;
      providerListeners.forEach((fn) => fn());
    },
    chain(next: number) {
      chain = next;
      networkListeners.forEach((fn) => fn());
    },
    async start() {
      const pending = adapter.connect();
      await vi.waitFor(() => expect(kit.open).toHaveBeenCalled());
      return { pending };
    },
  };
}

describe("WalletConnect adapter", () => {
  it("waits for connector initialization before opening the dialog", async () => {
    const fixture = setup();
    let ready!: () => void;
    fixture.kit.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const pending = fixture.adapter.connect();
    await vi.waitFor(() => expect(fixture.kit.ready).toHaveBeenCalled());
    expect(fixture.kit.open).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(fixture.kit.open).toHaveBeenCalled());
    fixture.account();
    fixture.provider();
    await expect(pending).resolves.toMatchObject({ address });
  });
  it("waits for account and provider, then signs exact bytes without assuming a session chain list", async () => {
    const fixture = setup();
    const { pending } = await fixture.start();
    fixture.account();
    fixture.provider();
    const session = await pending;
    expect(session.walletName).toBe("Example Wallet via WalletConnect");
    expect(session.chainId).toBe("0x279f");
    expect(
      fixture.request.mock.calls.every(
        ([request]) => request.method === "eth_accounts",
      ),
    ).toBe(true);
    await session.signMessage("hi\nπ");
    expect(fixture.request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: ["0x68690acf80", address],
    });
  });
  it("cancels a closed QR modal and releases its subscriptions", async () => {
    const fixture = setup();
    const { pending } = await fixture.start();
    const rejection = expect(pending).rejects.toMatchObject({
      kind: "cancelled",
    });
    await fixture.kit.close();
    await rejection;
    expect(fixture.kit.resetWalletConnectUri).toHaveBeenCalledOnce();
    expect(fixture.kit.disconnect).toHaveBeenCalledWith("eip155");
    expect(fixture.accountListeners.size).toBe(0);
    expect(fixture.providerListeners.size).toBe(0);
  });
  it("does not mistake success-driven modal close for cancellation before provider arrives", async () => {
    const fixture = setup();
    const { pending } = await fixture.start();
    fixture.account();
    await fixture.kit.close();
    fixture.provider();
    expect((await pending).address).toBe(address);
  });
  it("does not adopt a cancelled connection when verification resolves late", async () => {
    const fixture = setup();
    let finish!: (value: unknown) => void;
    fixture.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { pending } = await fixture.start();
    fixture.account();
    fixture.provider();
    const rejection = expect(pending).rejects.toMatchObject({
      kind: "cancelled",
    });
    await fixture.kit.disconnect();
    await fixture.kit.close();
    await rejection;
    finish([address]);
    await vi.waitFor(() =>
      expect(fixture.kit.disconnect.mock.calls.length).toBeGreaterThanOrEqual(
        2,
      ),
    );
  });
  it("rejects signatures when account changes during approval and publishes lifecycle events", async () => {
    const fixture = setup();
    const { pending } = await fixture.start();
    fixture.account();
    fixture.provider();
    const session = await pending;
    const events = vi.fn();
    session.subscribe!(events);
    fixture.request.mockImplementation(async ({ method }) => {
      if (method === "personal_sign") {
        fixture.account(other);
        return "0xsigned";
      }
      return [address];
    });
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "wrong-account",
    });
    expect(events).toHaveBeenCalledWith("accountsChanged");
    fixture.chain(1);
    expect(events).toHaveBeenCalledWith("chainChanged");
    await fixture.kit.disconnect();
    expect(events).toHaveBeenCalledWith("disconnect");
    session.dispose!();
    expect(fixture.accountListeners.size).toBe(0);
  });
  it("releases the operation if opening AppKit fails", async () => {
    const fixture = setup();
    fixture.kit.open.mockRejectedValueOnce({ code: 4001 });
    await expect(fixture.adapter.connect()).rejects.toMatchObject({
      code: 4001,
    });
    expect(fixture.stateListeners.size).toBe(0);
  });
  it("rejects missing and placeholder configuration", () => {
    expect(readReownProjectId(undefined)).toBeNull();
    expect(readReownProjectId("replace-with-project-id")).toBeNull();
    expect(readReownProjectId("0".repeat(32))).toBeNull();
    expect(readReownProjectId("a".repeat(32))).toBe("a".repeat(32));
  });
});
