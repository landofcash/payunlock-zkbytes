// @vitest-environment node
import { EventEmitter } from "node:events";
import type { EIP1193Provider } from "@metamask/connect-evm";
import { describe, expect, it, vi } from "vitest";
import { createMetaMaskAdapter } from "@/wallet/metamask-adapter";
import { walletErrorKind } from "@/wallet/errors";

const address = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222";
function setup() {
  const emitter = new EventEmitter();
  let accounts = [address as string];
  const request = vi.fn(
    async ({ method }: { method: string; params?: unknown }) =>
      method === "eth_accounts" ? accounts : "0xsigned",
  );
  const provider = Object.assign(emitter, { request });
  const client = {
    connect: vi.fn(async () => ({
      accounts: [address],
      chainId: "0x279f" as const,
    })),
    disconnect: vi.fn(async () => {}),
    switchChain: vi.fn(async () => {}),
    getProvider: () => provider as unknown as EIP1193Provider,
  };
  return {
    provider,
    client,
    request,
    adapter: createMetaMaskAdapter(async () => client),
    setAccounts(next: string[]) {
      accounts = next;
    },
  };
}
describe("MetaMask adapter", () => {
  it("supplies complete network details for the explicit add/switch action", async () => {
    const { adapter, client, request } = setup();
    const session = await adapter.connect();
    await session.switchNetwork!();
    expect(client.switchChain).toHaveBeenCalledWith({
      chainId: "0x279f",
      chainConfiguration: {
        chainId: "0x279f",
        chainName: "Monad Testnet",
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: ["https://testnet-rpc.monad.xyz"],
        blockExplorerUrls: ["https://testnet.monadvision.com"],
      },
    });
    expect(
      request.mock.calls.some(([call]) => call.method === "personal_sign"),
    ).toBe(false);
  });
  it("adds a missing network on raw 4902 and retries switching", async () => {
    const { adapter, client, request } = setup();
    const session = await adapter.connect();
    client.switchChain.mockRejectedValueOnce({ code: 4902 });
    await session.switchNetwork!();
    expect(
      request.mock.calls.some(
        ([call]) => call.method === "wallet_addEthereumChain",
      ),
    ).toBe(true);
    expect(client.switchChain).toHaveBeenCalledTimes(2);
  });
  it("requests the configured Monad network and refuses unconfigured networks", async () => {
    const { adapter, client, provider, request } = setup();
    const session = await adapter.connect();
    expect(client.connect).toHaveBeenCalledWith({ chainIds: ["0x279f"] });
    provider.emit("chainChanged", "0x1");
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "network",
    });
    expect(
      request.mock.calls.some(([call]) => call.method === "personal_sign"),
    ).toBe(false);
  });
  it("connects without signing and forwards exact UTF-8 personal_sign bytes", async () => {
    const { adapter, request } = setup();
    const session = await adapter.connect();
    expect(
      request.mock.calls.every(([call]) => call.method === "eth_accounts"),
    ).toBe(true);
    expect(await session.signMessage("hello\nπ")).toBe("0xsigned");
    expect(request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: ["0x68656c6c6f0acf80", address],
    });
  });
  it("refuses to sign when the selected account no longer matches", async () => {
    const { adapter, request, setAccounts } = setup();
    const session = await adapter.connect();
    setAccounts([other]);
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "wrong-account",
    });
    expect(
      request.mock.calls.some(([call]) => call.method === "personal_sign"),
    ).toBe(false);
  });
  it("rejects a result after an account switches away and back during approval", async () => {
    const { adapter, request, provider } = setup();
    const session = await adapter.connect();
    const listener = vi.fn();
    session.subscribe!(listener);
    request.mockImplementation(async ({ method }) => {
      if (method === "eth_accounts") return [address];
      provider.emit("accountsChanged", [other]);
      provider.emit("accountsChanged", [address]);
      return "0xsigned";
    });
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "wrong-account",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("updates account/network and removes listeners on disconnect", async () => {
    const { adapter, provider, client } = setup();
    const session = await adapter.connect();
    const events = vi.fn();
    session.subscribe!(events);
    provider.emit("accountsChanged", [other]);
    provider.emit("chainChanged", "0x2");
    expect(session.address).toBe(other);
    expect(session.chainId).toBe("0x2");
    expect(events.mock.calls).toEqual([["accountsChanged"], ["chainChanged"]]);
    await session.disconnect();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(provider.listenerCount("accountsChanged")).toBe(0);
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "disconnected",
    });
  });
  it("treats an empty account list as disconnect", async () => {
    const { adapter, provider } = setup();
    const session = await adapter.connect();
    const listener = vi.fn();
    session.subscribe!(listener);
    provider.emit("accountsChanged", []);
    expect(listener).toHaveBeenCalledWith("disconnect");
    await expect(session.signMessage("test")).rejects.toMatchObject({
      kind: "disconnected",
    });
  });
  it.each([
    [4001, "rejected"],
    [-32002, "pending"],
    [-32601, "unsupported"],
    [4900, "disconnected"],
    [999, "provider"],
  ])("maps provider code %s without exposing raw errors", (code, expected) => {
    expect(
      walletErrorKind({ code, message: "sensitive provider details" }),
    ).toBe(expected);
  });
});
