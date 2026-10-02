import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Asset, Configuration, Product } from "../commerce/client";
import type { Operation } from "../commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), list: vi.fn(), save: vi.fn(), prepare: vi.fn(), receiving: vi.fn(), authorize: vi.fn(), session: null as null | { address: string; locked?: boolean }, access: { authenticated: true, address: "account", busy: false, error: "" } }));
vi.mock("../commerce/client", () => ({ useCommerce: () => ({ request: mocks.request, read: mocks.read }), useCommerceAccess: () => ({ ...mocks.access, authorize: mocks.authorize }) }));
vi.mock("../wallet/session-store", () => ({ useSession: () => ({ sessionEpoch: 1, session: mocks.session, runOperation: (fn: (session: unknown, current: () => boolean) => unknown) => fn({}, () => true) }) }));
vi.mock("../commerce/protocol", async original => ({ ...await original<typeof import("../commerce/protocol")>(), restoreReceiving: mocks.receiving }));
vi.mock("../commerce/ui", async original => ({ ...await original<typeof import("../commerce/ui")>(), journal: { list: mocks.list, save: mocks.save }, prepareOperation: mocks.prepare, TransactionPanel: ({ record, onChange }: { record: Operation; onChange(value: Operation): void }) => record.progress === "checking" ? <button>Check status</button> : <button onClick={() => { if (record.action?.kind === "approve") { balances.allowance = configuration.terms.price; onChange({ ...record, progress: "draft", transaction: undefined }); } else onChange({ ...record, progress: "finalized", orderId: "42" }); }}>{record.action?.kind === "approve" ? "Approve token payment" : "Confirm payment"}</button> }));
import { BuyerCheckout, ProductPage } from "../commerce/ProductPage";
const account = `0x${"11".repeat(20)}`, contract = `0x${"22".repeat(20)}`, hash = `0x${"33".repeat(32)}`, native = `0x${"00".repeat(20)}`;
const product: Product = { id: "offer", title: "Workshop", description: "Private workshop", revision: 1 };
let configuration: Configuration, balances: Asset;
const operation = (progress: Operation["progress"] = "draft"): Operation => ({ id: "checkout", productId: product.id, requestId: hash, account, deployment: { chainId: 10143, contract }, receiving: { nonce: hash, publicKey: hash }, version: 1, progress, hashes: [], configuration });
const preview = () => ({ configuration, asset: { symbol: balances.symbol, decimals: balances.decimals } });
function checkout(resumeId?: string) { render(<MemoryRouter><BuyerCheckout product={product} preview={preview()} resumeId={resumeId} /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.authenticated = true; mocks.session = { address: account };
  configuration = { chainId: 10143, contract, seller: contract, productKey: hash, expectedTerms: hash, terms: { token: native, price: "1000000000000000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", responseWindow: "259200", commitmentWindow: "600" }, sellerReceiving: { nonce: hash, publicKey: hash }, authorizationMode: "direct-only", serviceFee: { bps: 0, treasury: contract, sellerCapBps: 0 }, status: 1, allowed: true, block: { number: 1, hash, timestamp: 1 } };
  balances = { token: native, symbol: "MON", decimals: 18, balance: "1000000000000000000", nativeBalance: "1000000000000000000", allowance: "0" };
  mocks.list.mockResolvedValue([]);
  mocks.save.mockImplementation(async (record: Operation) => ({ ...record, version: record.version + 1 }));
  mocks.prepare.mockImplementation(async (_api, record: Operation, action) => ({ ...record, action, progress: "review" }));
  mocks.receiving.mockImplementation(async context => ({ context, publicKey: btoa("\0".repeat(32)), privateKey: new Uint8Array(32) }));
  mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { chainId: 10143, contract } : path.startsWith("/public/wallets/") ? { ...balances } : path.endsWith("/preview") ? preview() : product);
  mocks.request.mockImplementation(async (path: string) => path.startsWith("/assets/") ? { ...balances } : { configuration });
});
it("shows public price and timing without authentication or receiving signatures", async () => {
  mocks.access.authenticated = false; mocks.session = null;
  render(<MemoryRouter initialEntries={["/products/offer"]}><Routes><Route path="/products/:id" element={<ProductPage />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Price")).toHaveTextContent("0.001 MON"));
  expect(screen.getByText("24 hours")).toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.receiving).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Buy" }));
  expect(await screen.findByRole("heading", { name: "Your purchase" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Payment" })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(mocks.authorize).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign in to continue" }));
  expect(mocks.authorize).toHaveBeenCalledOnce();
});
it("allows sign-in with a last-used wallet even when its public balance is too low", async () => {
  mocks.access.authenticated = false; mocks.session = null;
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract;
  configuration.terms.price = "1000000";
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "0" };
  checkout();
  expect(await screen.findByText("0.0 USDC")).toBeInTheDocument();
  const signIn = screen.getByRole("button", { name: "Sign in to continue" });
  expect(signIn).toBeEnabled();
  expect(screen.queryByText(/Authorize the exact token amount with one wallet signature/)).not.toBeInTheDocument();
  fireEvent.click(signIn);
  expect(mocks.authorize).toHaveBeenCalledOnce();
});
it("asks a connected wallet to verify checkout access instead of signing in again", async () => {
  mocks.access.authenticated = false;
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract;
  configuration.terms.price = "1000000";
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "10000000" };
  checkout();
  const verify = await screen.findByRole("button", { name: "Verify wallet to continue" });
  expect(verify).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Sign in to continue" })).not.toBeInTheDocument();
  fireEvent.click(verify);
  expect(mocks.authorize).toHaveBeenCalledOnce();
});
it("warns and disables receiving-key signing when the payment balance is too low", async () => {
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract;
  configuration.terms.price = "1000000";
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "0" };
  checkout();
  expect(await screen.findByRole("alert")).toHaveTextContent("Your USDC balance is too low for this purchase. Top up before continuing.");
  const signKey = screen.getByRole("button", { name: "Sign receiving key" });
  expect(signKey).toBeDisabled();
  fireEvent.click(signKey);
  expect(mocks.receiving).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalledWith("/products/offer/checkout", expect.anything());
  balances.balance = configuration.terms.price;
  fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
  await waitFor(() => expect(signKey).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("warns and disables receiving-key signing for the seller's own offer", async () => {
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract;
  configuration.terms.price = "1000000";
  configuration.seller = account;
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "10000000" };
  checkout();
  expect(await screen.findByRole("alert")).toHaveTextContent("You cannot buy your own offer.");
  const signKey = screen.getByRole("button", { name: "Sign receiving key" });
  expect(signKey).toBeDisabled();
  fireEvent.click(signKey);
  expect(mocks.receiving).not.toHaveBeenCalled();
});
it("signs the receiving key before preparing native payment, then confirms the transaction", async () => {
  checkout();
  await screen.findByText("1.0 MON");
  expect(mocks.receiving).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign receiving key and review" }));
  await waitFor(() => expect(mocks.receiving).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole("button", { name: "Confirm payment" }));
  expect(await screen.findByRole("heading", { name: "Order placed" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open order" })).toHaveAttribute("href", "/purchases/42");
  expect(screen.queryByRole("button", { name: "Refresh terms" })).not.toBeInTheDocument();
});
it("restores balances automatically without refreshing saved terms", async () => {
  mocks.list.mockResolvedValue([operation()]); checkout();
  expect(await screen.findByText("1.0 MON")).toBeInTheDocument();
  expect(mocks.read.mock.calls.some(([path]) => path.startsWith("/public/wallets/"))).toBe(true);
  expect(mocks.request.mock.calls.some(([path]) => path.includes("checkout/refresh"))).toBe(false);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("pending payments expose status checking without refresh or resubmission controls", async () => {
  mocks.list.mockResolvedValue([{ ...operation("checking"), action: { kind: "purchase", requestId: hash, expectedTerms: hash } }]); checkout();
  expect(await screen.findByRole("heading", { name: "Checking payment" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check transaction status" }));
  expect(screen.getByRole("dialog", { name: "Payment" })).toHaveTextContent("Check status");
  expect(screen.queryByRole("button", { name: /Refresh terms|Back to review|Continue/ })).not.toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("explains a failed relayer payment and offers a fresh authorization", async () => {
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract;
  configuration.terms.price = "1000000";
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "10000000" };
  mocks.list.mockResolvedValue([{ ...operation("checking"), relayJobId: "job-1" }]);
  mocks.request.mockResolvedValue({ status: "uncertain" });
  mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { chainId: 10143, contract }
    : path === "/relay/jobs/job-1" ? { status: "failed", transactionHash: null, failureReason: "DAILY_BUDGET" }
      : path.startsWith("/public/wallets/") ? { ...balances } : product);
  checkout();
  fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("relayer has reached its daily gas limit");
  expect(screen.getByRole("alert")).toHaveTextContent("No payment was made.");
  expect(screen.getByRole("button", { name: "Try authorization again" })).toBeEnabled();
});
it("starts a new checkout when the latest purchase of this offer is finalized", async () => {
  mocks.list.mockResolvedValue([operation(), { ...operation("finalized"), id: "later", orderId: "42" }]); checkout();
  expect(await screen.findByRole("heading", { name: "Payment" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Order placed" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh terms" })).not.toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("resumes the exact unfinished purchase selected from Purchases", async () => {
  mocks.list.mockResolvedValue([operation(), { ...operation("finalized"), id: "later", orderId: "42" }]); checkout("checkout");
  expect(await screen.findByRole("button", { name: "Refresh terms" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Order placed" })).not.toBeInTheDocument();
});
it("stops payment preparation when the offer terms change", async () => {
  mocks.request.mockImplementation(async (path: string) => path.startsWith("/assets/") ? balances : { configuration: { ...configuration, expectedTerms: `0x${"44".repeat(32)}` } });
  checkout(); await screen.findByText("1.0 MON");
  fireEvent.click(screen.getByRole("button", { name: "Sign receiving key and review" }));
  expect(await screen.findByText(/The offer terms changed/)).toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("treats token approval as a separate step before payment, never as order success", async () => {
  configuration.terms.token = contract; balances.token = contract; balances.symbol = "USDC"; balances.decimals = 6; balances.balance = "1000000"; configuration.terms.price = "1000000";
  mocks.list.mockResolvedValue([operation()]); checkout(); await screen.findByText("1.0 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Review token approval" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve token payment" }));
  expect(await screen.findByRole("button", { name: "Continue to payment" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Order placed" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  expect(await screen.findByRole("button", { name: "Confirm payment" })).toBeInTheDocument();
  expect(mocks.prepare.mock.calls.map(call => call[2].kind)).toEqual(["approve", "purchase"]);
});
it("refreshing balances preserves the reviewed transaction", async () => {
  mocks.list.mockResolvedValue([{ ...operation("review"), action: { kind: "purchase", requestId: hash, expectedTerms: hash } }]); checkout();
  fireEvent.click(await screen.findByText("Your balance"));
  const refresh = await screen.findByRole("button", { name: "Refresh balance" }); fireEvent.click(refresh);
  await waitFor(() => expect(mocks.read.mock.calls.filter(([path]) => path.startsWith("/public/wallets/")).length).toBeGreaterThan(1));
  fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
  expect(screen.getByRole("dialog", { name: "Payment" })).toHaveTextContent("Confirm payment");
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});

function coveredCheckout() {
  configuration.authorizationMode = "eip3009-receive";
  configuration.terms.token = contract; configuration.terms.price = "1000000";
  balances = { ...balances, token: contract, symbol: "USDC", decimals: 6, balance: "10000000", allowance: "0" };
  mocks.request.mockImplementation(async (path: string) => path.startsWith("/orders/recover/") ? { status: "uncertain" } : { configuration });
}

it("switches fee modes both ways without changing checkout identity or receiving keys", async () => {
  coveredCheckout();
  const saved = operation(); mocks.list.mockResolvedValue([saved]); checkout();
  const toggle = await screen.findByRole("switch", { name: "Pay network fee myself" });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Network fee covered.")).toBeInTheDocument();
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "Review token approval" });
  expect(toggle).toBeChecked();
  expect(screen.getByRole("group", { name: "MON balance" })).toBeInTheDocument();
  expect(screen.getByText("You pay network fees in MON.")).toBeInTheDocument();
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "Authorize token payment" });
  expect(toggle).not.toBeChecked();
  expect(screen.queryByRole("group", { name: "MON balance" })).not.toBeInTheDocument();
  const next = mocks.save.mock.calls.at(-1)![0];
  expect(next).toMatchObject({ id: saved.id, requestId: saved.requestId, receiving: saved.receiving, payNetworkFeeSelf: false });
  expect(mocks.receiving).not.toHaveBeenCalled();
});

it("opens approval after selecting self-paid fees, then clears the prepared transaction when switching back", async () => {
  coveredCheckout(); const saved = operation(); mocks.list.mockResolvedValue([saved]); checkout();
  fireEvent.click(await screen.findByRole("switch", { name: "Pay network fee myself" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review token approval" }));
  expect(await screen.findByRole("button", { name: "Approve token payment" })).toBeInTheDocument();
  expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: saved.requestId, receiving: saved.receiving }), expect.objectContaining({ kind: "approve" }), true);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  fireEvent.click(screen.getByRole("switch", { name: "Pay network fee myself" }));
  await screen.findByRole("button", { name: "Authorize token payment" });
  expect(mocks.save.mock.calls.at(-1)![0]).toMatchObject({ action: undefined, transaction: undefined, activeHash: undefined, progress: "draft" });
});

it("restores the saved self-payment choice on reopening a checkout", async () => {
  coveredCheckout(); mocks.list.mockResolvedValue([{ ...operation(), payNetworkFeeSelf: true }]); checkout();
  expect(await screen.findByRole("button", { name: "Review token approval" })).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Pay network fee myself" })).toBeChecked();
});

it("keeps a fee choice made before signing in when starting a new checkout", async () => {
  coveredCheckout(); mocks.access.authenticated = false; mocks.session = null;
  const view = render(<MemoryRouter><BuyerCheckout product={product} preview={preview()} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("switch", { name: "Pay network fee myself" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Pay network fee myself" })).toBeChecked());
  mocks.access.authenticated = true; mocks.session = { address: account };
  view.rerender(<MemoryRouter><BuyerCheckout product={product} preview={preview()} /></MemoryRouter>);
  await screen.findByRole("button", { name: "Sign receiving key and review" });
  expect(screen.getByRole("switch", { name: "Pay network fee myself" })).toBeChecked();
});

it("disables fee changes during an unresolved direct token approval", async () => {
  coveredCheckout(); mocks.list.mockResolvedValue([{ ...operation("checking"), payNetworkFeeSelf: true, action: { kind: "approve", requestId: hash, expectedTerms: hash } }]); checkout();
  const toggle = await screen.findByRole("switch", { name: "Pay network fee myself" });
  expect(toggle).toBeChecked(); expect(toggle).toBeDisabled();
  fireEvent.click(toggle);
  expect(mocks.save).not.toHaveBeenCalled();
});

it.each([undefined, "relay-job"])("disables fee changes while submitted payment is unresolved (%s)", async relayJobId => {
  coveredCheckout(); mocks.list.mockResolvedValue([{ ...operation("checking"), relayJobId }]); checkout();
  const toggle = await screen.findByRole("switch", { name: "Pay network fee myself" });
  expect(toggle).toBeDisabled();
  fireEvent.click(toggle);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
