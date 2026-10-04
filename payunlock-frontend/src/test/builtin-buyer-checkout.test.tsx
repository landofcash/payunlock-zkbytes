import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Asset, Configuration, Product } from "../commerce/client";
import type { Operation } from "../commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), list: vi.fn(), save: vi.fn(), receiving: vi.fn(), prepare: vi.fn(), execute: vi.fn(), check: vi.fn(), authorize: vi.fn(), authenticated: true }));
const address = `0x${"11".repeat(20)}`, escrow = `0x${"22".repeat(20)}`, hash = `0x${"33".repeat(32)}`, native = `0x${"00".repeat(20)}`;
const session = { kind: "builtin", address, locked: false };
vi.mock("../commerce/client", async original => ({ ...await original<typeof import("../commerce/client")>(), useCommerce: () => ({ read: mocks.read, request: mocks.request }), useCommerceAccess: () => ({ address, authenticated: mocks.authenticated, busy: false, error: "", authorize: mocks.authorize }) }));
vi.mock("../wallet/session-store", () => ({ useSession: () => ({ session, sessionEpoch: 1, runOperation: (fn: (session: unknown, current: () => boolean) => unknown) => fn(session, () => true) }) }));
vi.mock("../commerce/ui", async original => ({ ...await original<typeof import("../commerce/ui")>(), journal: { list: mocks.list, save: mocks.save } }));
vi.mock("../commerce/protocol", async original => ({ ...await original<typeof import("../commerce/protocol")>(), restoreReceiving: mocks.receiving }));
vi.mock("../commerce/builtin-purchase", async original => ({ ...await original<typeof import("../commerce/builtin-purchase")>(), prepareBuiltinPurchase: mocks.prepare, executeBuiltinPurchase: mocks.execute, checkBuiltinPurchase: mocks.check }));
import { BuyerCheckout } from "../commerce/ProductPage";
const product: Product = { id: "workshop", title: "Workshop", description: "A workshop", revision: 1 };
let configuration: Configuration, asset: Asset;
const saved = (progress: Operation["progress"]): Operation => ({ id: hash, requestId: hash, account: address, productId: product.id, deployment: { chainId: 10143, contract: escrow }, configuration, receiving: { nonce: hash, publicKey: hash }, hashes: [], progress, version: 1 });
const checkout = () => render(<MemoryRouter><BuyerCheckout product={product} preview={{ configuration, asset }} /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticated = true;
  configuration = { chainId: 10143, contract: escrow, seller: escrow, productKey: hash, expectedTerms: hash, terms: { token: native, price: "1000000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", commitmentWindow: "600", responseWindow: "600" }, sellerReceiving: { nonce: hash, publicKey: hash }, status: 1, allowed: true, block: { number: 1, hash, timestamp: 1 }, authorizationMode: "direct-only", serviceFee: { bps: 0, treasury: escrow, sellerCapBps: 0 } };
  asset = { token: native, symbol: "MON", decimals: 18, balance: "1000000000000000000", nativeBalance: "1000000000000000000", allowance: "0" };
  mocks.list.mockResolvedValue([]); mocks.save.mockImplementation(async (record: Operation) => ({ ...record, version: record.version + 1 }));
  mocks.read.mockImplementation(async path => path === "/deployment" ? { chainId: 10143, contract: escrow, router: escrow, usdc: escrow } : asset);
  mocks.request.mockImplementation(async () => ({ configuration }));
  mocks.receiving.mockImplementation(async context => ({ context, publicKey: btoa("\0".repeat(32)), privateKey: new Uint8Array(32) }));
  mocks.prepare.mockImplementation(async (_api, record: Operation) => ({ record, maxNetworkFee: 1000000n, scope: { transactions: [] } }));
  mocks.execute.mockImplementation(async ({ plan, onChange }) => onChange({ ...plan.record, progress: "checking", activeHash: hash }));
  mocks.check.mockImplementation(async (_api, _journal, record) => record);
});
it("prepares automatically and places a built-in purchase with a single approval", async () => {
  checkout();
  const pay = await screen.findByRole("button", { name: /Pay .* and place order/ });
  await waitFor(() => expect(pay).toBeEnabled());
  expect(mocks.receiving).toHaveBeenCalledOnce(); expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.execute).not.toHaveBeenCalled();
  expect(screen.queryByText("Sign receiving key")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Confirm payment" })).not.toBeInTheDocument();
  expect(screen.getByText(/Maximum total network fee/)).toHaveTextContent("0.000000000001 MON");
  fireEvent.click(pay);
  expect(await screen.findByRole("heading", { name: "Checking payment" })).toBeInTheDocument(); expect(mocks.execute).toHaveBeenCalledOnce();
  mocks.check.mockImplementation(async (_api, _journal, record) => ({ ...record, progress: "finalized", orderId: "42" }));
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  expect(await screen.findByRole("heading", { name: "Order placed" })).toBeInTheDocument();
});
it("restores a pending checkout without preparing or paying again", async () => {
  mocks.list.mockResolvedValue([{ ...saved("checking"), activeHash: hash, action: { kind: "purchase", requestId: hash, expectedTerms: hash } }]);
  checkout(); await screen.findByRole("heading", { name: "Checking payment" });
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.receiving).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Pay .* and place order/ })).not.toBeInTheDocument();
});
it("shows updated terms before enabling payment and does not spend automatically", async () => {
  mocks.request.mockResolvedValue({ configuration: { ...configuration, expectedTerms: `0x${"44".repeat(32)}`, terms: { ...configuration.terms, price: "2000000" } } });
  checkout(); expect(await screen.findByText(/The offer terms changed/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: /Pay 0.000000000002 MON and place order/ })).toBeEnabled());
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each(["lower price", "changed token"])("refreshes saved checkout terms before reading the balance for a %s", async change => {
  const previous = saved("draft"), oldToken = `0x${"55".repeat(20)}`;
  if (change === "changed token") previous.configuration = { ...configuration, terms: { ...configuration.terms, token: oldToken } };
  const refreshed = { ...configuration, expectedTerms: `0x${"44".repeat(32)}`, terms: { ...configuration.terms, price: "500000" } };
  asset.balance = "750000";
  mocks.list.mockResolvedValue([previous]);
  mocks.request.mockResolvedValue({ configuration: refreshed });
  mocks.read.mockImplementation(async path => {
    if (path === "/deployment") return { chainId: 10143, contract: escrow };
    if (path.endsWith(oldToken)) throw new Error("The old payment token is disabled.");
    expect(mocks.request).toHaveBeenCalledWith(`/products/${product.id}/checkout/refresh`, { requestId: previous.requestId });
    return asset;
  });
  checkout();
  await waitFor(() => expect(screen.getByRole("button", { name: /Pay 0.0000000000005 MON and place order/ })).toBeEnabled());
  expect(screen.getByText(/The offer terms changed/)).toBeInTheDocument();
  expect(mocks.read).not.toHaveBeenCalledWith(`/public/wallets/${address}/assets/${oldToken}`);
  expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: previous.id, receiving: previous.receiving, configuration: refreshed }), asset, product.title);
  expect(mocks.receiving).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
it("keeps payment disabled when the refreshed saved checkout is still unaffordable", async () => {
  const { prepareBuiltinPurchase } = await vi.importActual<typeof import("../commerce/builtin-purchase")>("../commerce/builtin-purchase");
  mocks.prepare.mockImplementation(prepareBuiltinPurchase);
  mocks.list.mockResolvedValue([saved("draft")]);
  const refreshed = { ...configuration, expectedTerms: `0x${"44".repeat(32)}`, terms: { ...configuration.terms, price: "500000" } };
  mocks.request.mockResolvedValue({ configuration: refreshed }); asset.balance = "250000";
  checkout();
  expect(await screen.findByRole("alert")).toHaveTextContent("Top up your payment balance");
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ configuration: refreshed }));
  expect(screen.getByRole("button", { name: /Pay 0.0000000000005 MON and place order/ })).toBeDisabled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("requires a fresh approval after recovering a completed token approval", async () => {
  mocks.list.mockResolvedValue([{ ...saved("checking"), activeHash: hash, action: { kind: "approve", requestId: hash, expectedTerms: hash }, payNetworkFeeSelf: true }]);
  mocks.check.mockImplementation(async (_api, _journal, record) => ({ ...record, progress: "draft", action: undefined, transaction: undefined, activeHash: undefined }));
  checkout(); fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Pay .* and place order/ })).toBeEnabled());
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("does not prepare or sign a payment when the buyer balance is too low", async () => {
  asset.balance = "0"; checkout(); expect(await screen.findByRole("alert")).toHaveTextContent("Top up your payment balance");
  expect(mocks.receiving).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Pay .* and place order/ })).toBeDisabled();
});
it("retries uncertain sponsored submission with one click and the same purchase identity", async () => {
  const previous = { ...saved("checking"), relayNonce: hash };
  mocks.list.mockResolvedValue([previous]);
  mocks.request.mockResolvedValue({ status: "not_found" }); checkout();
  fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
  await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  expect(mocks.request).toHaveBeenCalledWith(`/orders/recover/${hash}`);
  expect(mocks.execute.mock.calls[0]![0].plan.record).toMatchObject({ id: previous.id, requestId: previous.requestId, receiving: previous.receiving });
  expect(mocks.receiving).not.toHaveBeenCalled();
});
it("shows the completed order instead of resubmitting when retry finds an earlier success", async () => {
  const previous = { ...saved("checking"), relayNonce: hash };
  mocks.list.mockResolvedValue([previous]);
  mocks.request.mockResolvedValue({ status: "finalized", orderId: "42", order: { buyer: address, requestId: hash, buyerReceiving: previous.receiving } }); checkout();
  fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
  expect(await screen.findByRole("heading", { name: "Order placed" })).toBeInTheDocument();
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("retains the retry option when the recovery check fails", async () => {
  mocks.list.mockResolvedValue([{ ...saved("checking"), relayNonce: hash }]);
  mocks.request.mockRejectedValue(new Error("Service unavailable")); checkout();
  fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
  expect(screen.getByRole("button", { name: "Retry payment" })).toBeEnabled();
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it("does not offer retry for an accepted relay job", async () => {
  mocks.list.mockResolvedValue([{ ...saved("checking"), relayNonce: hash, relayJobId: "job" }]); checkout();
  await screen.findByRole("button", { name: "Check payment status" });
  expect(screen.queryByRole("button", { name: "Retry payment" })).not.toBeInTheDocument();
});
it("keeps the previous attempt recoverable if retry preparation fails", async () => {
  mocks.list.mockResolvedValue([{ ...saved("checking"), relayNonce: hash }]);
  mocks.request.mockResolvedValue({ status: "not_found" });
  mocks.prepare.mockRejectedValueOnce(new Error("Top up your payment balance to continue.")); checkout();
  fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Top up your payment balance");
  expect(screen.getByRole("button", { name: "Check payment status" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Retry payment" })).toBeEnabled();
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
