import "fake-indexeddb/auto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { useEffect } from "react";
import { App } from "@/App";
import { SessionProvider, useSession } from "@/wallet/session-store";
import { ApprovalProvider } from "@/wallet/ApprovalProvider";
import { CommerceProvider, ProtectedAccess, useCommerce } from "@/commerce/client";
import { IndexedStore } from "@/storage/local-store";
import { LAST_USED_KEY } from "@/wallet/last-used";
import type { LabWalletSession, WalletSessionEvent } from "@/wallet/types";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), unlock: vi.fn() }));
vi.mock("@/wallet/metamask-adapter", () => ({ metamaskAdapter: { connect: mocks.connect } }));
vi.mock("@/wallet/managed-session", async original => ({ ...await original<typeof import("@/wallet/managed-session")>(), unlockWallet: mocks.unlock }));
const address = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const store = new IndexedStore();
let sign: Mock<() => Promise<string>>, appSign: Mock<() => Promise<string>>, session: LabWalletSession;
let notify: (event: WalletSessionEvent) => void;
let paths: string[];
let protectedClient: ReturnType<typeof useCommerce>;
const publicOrder = { orderId: "7", block: { number: 50, hash: "0x00", timestamp: 100 }, canceled: false,
  order: { state: 1, buyer: address, seller: other, terms: { token: `0x${"00".repeat(20)}`, price: "1000000000000000000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", responseWindow: "259200", commitmentWindow: "600" }, publicationDeadline: "0", reviewDeadline: "0", responseDeadline: "0" }, offer: { id: "offer", title: "Public offer", description: "Public description" } };
beforeEach(async () => {
  paths = []; localStorage.clear(); await store.remove("wallet:selected");
  sign = vi.fn(async () => "0xsignature"); appSign = vi.fn(async () => "0xsignature");
  session = { kind: "metamask", walletName: "MetaMask", transport: "extension", address, chainId: "0x279f", signMessage: sign, disconnect: async () => {}, subscribe: listener => { notify = listener; return () => {}; } };
  mocks.connect.mockResolvedValue(session); mocks.unlock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname + new URL(input).search; paths.push(path);
    const value = path === "/health" ? { status: "ok", service: "payunlock-api" }
      : path.startsWith("/v1/public/orders?") ? { items: [{ ...publicOrder, orderId: path.includes("after=") ? "8" : "7", order: { ...publicOrder.order, seller: path.includes("seller=") ? address : other } }], nextCursor: path.includes("after=") ? null : "7" }
      : path === "/v1/public/orders/7" ? publicOrder
      : path === "/v1/auth/challenge" ? { id: "challenge", message: "Login challenge" }
      : path === "/v1/auth/verify" ? { token: "test-token", expiresAt: new Date(Date.now() + 60000).toISOString() }
      : path === "/v1/protected" ? { ok: true }
      : { items: [], nextCursor: null };
    return { ok: true, json: async () => value };
  }));
});
afterEach(() => vi.unstubAllGlobals());
function Controls() {
  const wallet = useSession();
  return <><button onClick={() => void wallet.connectMetaMask()}>Connect test wallet</button><button onClick={() => void wallet.disconnect()}>Disconnect test wallet</button><output data-testid="connected-wallet">{wallet.session?.address ?? "none"}</output></>;
}
async function connectTestWallet() { fireEvent.click(screen.getByText("Connect test wallet")); await waitFor(() => expect(screen.getByTestId("connected-wallet")).toHaveTextContent(address)); }
function PrivateProbe() {
  const api = useCommerce();
  protectedClient = api;
  useEffect(() => { void api.request("/protected"); }, []);
  return <p>Protected data opened</p>;
}
function mount(path = "/purchases") {
  return render(<MemoryRouter initialEntries={[path]}><SessionProvider><Controls /><App apiOrigin="http://localhost:4321" walletsEnabled /></SessionProvider></MemoryRouter>);
}
function mountAccess() {
  return render(<MemoryRouter><SessionProvider><Controls /><ApprovalProvider><CommerceProvider origin="http://localhost:4321"><ProtectedAccess label="Open protected data"><PrivateProbe /></ProtectedAccess></CommerceProvider></ApprovalProvider></SessionProvider></MemoryRouter>);
}
it("connects, refreshes, paginates and opens public orders without signing", async () => {
  mount(); fireEvent.click(screen.getByText("Connect test wallet"));
  expect(await screen.findByRole("link", { name: "Open order #7" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(paths.filter(p => p.startsWith("/v1/public/orders?")).length).toBeGreaterThan(1));
  await waitFor(() => expect(screen.getByText("More purchases")).toBeEnabled());
  fireEvent.click(screen.getByText("More purchases"));
  expect(await screen.findByRole("link", { name: "Open order #8" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "Open order #7" }));
  expect(await screen.findByText("Public description")).toBeInTheDocument();
  expect(sign).not.toHaveBeenCalled();
  expect(paths.some(p => /auth|seller|\/v1\/orders/.test(p))).toBe(false);
});
it("browses sales with a saved locked wallet without unlocking or loading drafts", async () => {
  localStorage.setItem(LAST_USED_KEY, JSON.stringify({ address, kind: "password" })); mount("/sales");
  expect(await screen.findByRole("heading", { name: "Public offer" })).toBeInTheDocument();
  expect(mocks.unlock).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  expect(paths.some(p => /\/v1\/(auth|seller)\//.test(p))).toBe(false);
});
it("authenticates only after explicit access and clears the grant on account change", async () => {
  mountAccess(); await connectTestWallet();
  const button = await screen.findByText("Open protected data");
  expect(sign).not.toHaveBeenCalled(); fireEvent.click(button);
  expect(await screen.findByText("Protected data opened")).toBeInTheDocument();
  await waitFor(() => expect(paths).toContain("/v1/protected"));
  expect(sign).toHaveBeenCalledTimes(1);
  const oldClient = protectedClient;
  act(() => { session.address = other; notify("accountsChanged"); });
  expect(await screen.findByText("Open protected data")).toBeInTheDocument();
  expect(screen.queryByText("Protected data opened")).not.toBeInTheDocument();
  expect(sign).toHaveBeenCalledTimes(1);
  await expect(oldClient.request("/protected")).rejects.toThrow("Wallet changed");
  expect(sign).toHaveBeenCalledTimes(1);
});
it("expires protected access without a background reauthentication prompt", async () => {
  mountAccess(); await connectTestWallet();
  fireEvent.click(await screen.findByText("Open protected data"));
  await screen.findByText("Protected data opened");
  const oldClient = protectedClient, now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  try {
    await act(async () => { await expect(oldClient.request("/protected")).rejects.toThrow("Sign in again"); });
    expect(screen.queryByText("Protected data opened")).not.toBeInTheDocument();
    expect(sign).toHaveBeenCalledTimes(1);
  } finally { now.mockRestore(); }
});
it("allows rejection then explicit retry without automatic signature loops", async () => {
  sign.mockRejectedValueOnce(new Error("User rejected signing"));
  mountAccess(); await connectTestWallet();
  fireEvent.click(await screen.findByText("Open protected data"));
  expect(await screen.findByRole("alert")).toHaveTextContent("User rejected signing");
  expect(sign).toHaveBeenCalledTimes(1); expect(paths).not.toContain("/v1/protected");
  fireEvent.click(screen.getByText("Open protected data"));
  expect(await screen.findByText("Protected data opened")).toBeInTheDocument(); expect(sign).toHaveBeenCalledTimes(2);
});
it("shows the account chooser when a saved wallet is unavailable locally", async () => {
  await store.put("wallet:selected", address);
  mocks.unlock.mockImplementation(async () => ({ ...session, kind: "builtin", transport: "managed", signAppAuthentication: appSign, dispose: vi.fn() }));
  mountAccess(); fireEvent.click(await screen.findByText("Open protected data"));
  expect(await screen.findByRole("dialog")).toHaveTextContent("Sign in to continue");
  expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeInTheDocument();
  expect(mocks.unlock).not.toHaveBeenCalled(); expect(appSign).not.toHaveBeenCalled();
});

it("shows My offers before authentication without loading private drafts", async () => {
  await store.put("wallet:selected", address); mount("/sales");
  fireEvent.click(screen.getByRole("button", { name: "Seller menu" }));
  fireEvent.click(screen.getByRole("link", { name: "My Offers" }));
  expect(await screen.findByRole("button", { name: "Open my offers" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "My offers" })).toBeInTheDocument();
  expect(mocks.unlock).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  expect(paths.some(p => /\/v1\/(auth|seller)\//.test(p))).toBe(false);
});
