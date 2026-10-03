import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Product } from "../commerce/client";
import type { Operation } from "../commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), list: vi.fn(), prepare: vi.fn(), matches: vi.fn(), authorize: vi.fn(), session: null as null | { address: string }, authenticated: true }));
vi.mock("../commerce/client", () => ({ useCommerce: () => ({ request: mocks.request, read: mocks.read }), useCommerceAccess: () => ({ authenticated: mocks.authenticated, authorize: mocks.authorize, error: "" }) }));
vi.mock("../wallet/session-store", () => ({ useSession: () => ({ sessionEpoch: 1, session: mocks.session, runOfferKeysOperation: (_context: unknown, _approval: unknown, fn: (keys: unknown) => unknown) => fn({ encryptionPublicKey: new Uint8Array(32) }) }) }));
vi.mock("../commerce/registration", () => ({ registrationMatches: mocks.matches }));
vi.mock("../commerce/OfferFields", () => ({ OfferFields: ({ onValidity, form, onChange }: { onValidity(value: boolean): void; form: Product; onChange(value: Product): void }) => { useEffect(() => onValidity(true), [onValidity]); return <><label>Title<input value={form.title} onChange={event => onChange({ ...form, title: event.target.value })} /></label><label>Price<input value={form.draftTerms?.price} onChange={event => onChange({ ...form, draftTerms: { ...form.draftTerms!, price: event.target.value } })} /></label></>; } }));
vi.mock("../commerce/ui", async importOriginal => ({ ...await importOriginal<typeof import("../commerce/ui")>(), journal: { list: mocks.list, save: async (value: Operation) => ({ ...value, version: value.version + 1 }) }, prepareOperation: mocks.prepare, TransactionPanel: ({ onChange, onFinalized, record }: { record: Operation; onChange(record: Operation): void; onFinalized(): Promise<void> }) => <button onClick={async () => { onChange({ ...record, progress: "finalized" }); await onFinalized(); }}>Simulate confirmation</button> }));
import { SellerEditor } from "../commerce/Seller";
let product: Product;
let registered: boolean;
const config = { contract: `0x${"22".repeat(20)}`, productTerms: { token: `0x${"00".repeat(20)}`, price: "1000", hasEventEnd: false, eventEnd: "0", hasReviewOverride: false, reviewOverride: "0", commitmentWindow: "600" }, sellerReceiving: { nonce: `0x${"44".repeat(32)}`, publicKey: `0x${"55".repeat(32)}` }, terms: { price: "1000", token: `0x${"00".repeat(20)}`, reviewWindow: "86400", responseWindow: "86400", commitmentWindow: "600", eventEnd: "0", hasEventEnd: false }, status: 1 };
const publication = (progress: Operation["progress"]): Operation => ({ id: "operation", account: `0x${"11".repeat(20)}`, productId: product.id, deployment: { chainId: 10143, contract: `0x${"22".repeat(20)}` }, version: 1, hashes: [], progress, publication: { visibility: "hidden", revision: 1 } });
function editorRoutes(path = "/create") { return <MemoryRouter initialEntries={[path]}><Routes><Route path="/create" element={<SellerEditor />} /><Route path="/sales/products/:id" element={<SellerEditor />} /><Route path="/offers" element={<h1>Offers list</h1>} /></Routes></MemoryRouter>; }
function open(path = "/create") { return render(editorRoutes(path)); }
beforeEach(() => {
  vi.clearAllMocks(); registered = false; mocks.session = { address: `0x${"11".repeat(20)}` }; mocks.authenticated = true;
  product = { id: "11111111-1111-4111-8111-111111111111", title: "Example offer", description: "Content", revision: 1, visibility: "draft", draftTerms: { token: `0x${"00".repeat(20)}`, price: "1000", eventEnd: null, reviewWindow: null, commitmentWindow: 600 } };
  mocks.list.mockResolvedValue([]); mocks.matches.mockReturnValue(true);
  mocks.prepare.mockImplementation(async (_api, record, action) => ({ ...record, action, progress: "review" }));
  mocks.read.mockImplementation(async path => path === "/platform" ? { minCommitmentWindow: 60, maxCommitmentWindow: 86400, offerPlacementFee: "0", placementFeeVersion: "1", serviceFeeBps: 0 } : { chainId: 10143, contract: `0x${"22".repeat(20)}`, reviewWindow: "86400" });
  mocks.request.mockImplementation(async (path: string, body?: Partial<Product>) => {
    if (path.startsWith("/assets/")) return { symbol: "MON", decimals: 18 };
    if (path.endsWith("/registration")) { if (!body && !registered) throw Error("Not registered"); return { configuration: config }; }
    if (body && path !== "/seller/products") product = { ...product, ...body, revision: product.revision + 1 };
    return product;
  });
});
it("keeps the anonymous draft and signs in only when review is requested", async () => {
  mocks.session = null; mocks.authenticated = false;
  const view = open();
  const review = await screen.findByRole("button", { name: "Review draft" });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsigned draft" } });
  await waitFor(() => expect(review).toBeEnabled());
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalledWith("/seller/products", expect.anything());
  fireEvent.click(review);
  expect(mocks.authorize).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalledWith("/seller/products", expect.anything());
  expect(screen.getByLabelText("Title")).toHaveValue("Unsigned draft");
  mocks.session = { address: `0x${"11".repeat(20)}` }; mocks.authenticated = true;
  view.rerender(editorRoutes());
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/seller/products", expect.objectContaining({ title: "Unsigned draft" })));
});
it("shows the publishing cost and reveals fee and visibility details on request", async () => {
  mocks.read.mockImplementation(async path => path === "/platform" ? { minCommitmentWindow: 60, maxCommitmentWindow: 86400, offerPlacementFee: "1000000000000000000", placementFeeVersion: "1", serviceFeeBps: 100 } : { chainId: 10143, contract: `0x${"22".repeat(20)}`, reviewWindow: "86400" });
  open();
  const review = await screen.findByRole("button", { name: "Review draft" });
  await waitFor(() => expect(review).toBeEnabled());
  fireEvent.click(review);
  expect(await screen.findByText("Publishing costs 1.0 MON, paid once.")).toBeInTheDocument();
  expect(screen.queryByText(/Service fee: up to/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "About publishing fees and visibility" }));
  expect(screen.getByRole("dialog", { name: "Publishing fees and visibility" })).toHaveTextContent("Service fee: up to 1.00% of your payout on completed sales.");
  expect(screen.getByRole("dialog", { name: "Publishing fees and visibility" })).toHaveTextContent("Public offers appear in Discover; private offers are available by link.");
  fireEvent.click(screen.getByRole("button", { name: "Close publishing details" }));
  expect(screen.queryByRole("dialog", { name: "Publishing fees and visibility" })).not.toBeInTheDocument();
});
it.each([ ["Public", "public"], ["Private", "hidden"] ])("saves a draft, reviews, and applies %s visibility only after confirmation", async (label, visibility) => {
  open();
  const review = await screen.findByRole("button", { name: "Review draft" });
  await waitFor(() => expect(review).toBeEnabled()); fireEvent.click(review);
  expect(await screen.findByRole("heading", { name: "Example offer" })).toBeInTheDocument();
  expect(mocks.request).toHaveBeenCalledWith("/seller/products", expect.objectContaining({ visibility: "draft" }));
  const publish = screen.getByRole("button", { name: "Publish" });
  expect(publish).toBeDisabled();
  expect(screen.getByRole("radio", { name: "Private" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Public" })).not.toBeChecked();
  const choice = screen.getByRole("radio", { name: label });
  fireEvent.click(choice); fireEvent.click(choice);
  expect(choice).toBeChecked(); expect(publish).toBeEnabled();
  expect(mocks.prepare).not.toHaveBeenCalled();
   fireEvent.click(publish);
   expect(await screen.findByRole("heading", { name: "Review transaction and results" })).toBeInTheDocument();
   const confirmation = await screen.findByRole("dialog", { name: "Publish offer" });
   expect(confirmation).toHaveTextContent("Simulate confirmation");
   expect(product.visibility).toBe("draft");
  registered = true; fireEvent.click(screen.getByRole("button", { name: "Simulate confirmation" }));
  expect(await screen.findByRole("heading", { name: "Offer published" })).toBeInTheDocument(); expect(product.visibility).toBe(visibility);
  fireEvent.click(screen.getByRole("link", { name: "Back to offers" })); expect(await screen.findByRole("heading", { name: "Offers list" })).toBeInTheDocument();
});
it("resumes a confirmed transaction without preparing another transaction", async () => {
  registered = true; mocks.list.mockResolvedValue([publication("finalized")]); open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Finish publishing" }));
  expect(await screen.findByRole("heading", { name: "Offer published" })).toBeInTheDocument(); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("does not publish mismatched confirmed settings", async () => {
  registered = true; mocks.matches.mockReturnValue(false); mocks.list.mockResolvedValue([publication("finalized")]); open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Finish publishing" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Confirmed settings do not match"); expect(product.visibility).toBe("draft");
});
it("opens an already published offer for management instead of repeating the wizard", async () => {
  registered = true; product.visibility = "hidden"; product.revision = 2; mocks.list.mockResolvedValue([publication("finalized")]); open(`/sales/products/${product.id}`);
  expect(await screen.findByRole("heading", { name: "Manage offer" })).toBeInTheDocument(); expect(screen.queryByLabelText("Offer creation steps")).not.toBeInTheDocument();
});

it("rejects publication if another session changed the saved draft", async () => {
  registered = true; mocks.list.mockResolvedValue([publication("finalized")]); product.revision = 3; open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Finish publishing" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session"); expect(product.visibility).toBe("draft");
  expect(screen.getByRole("button", { name: "Back to draft review" })).toBeEnabled();
});

it("switches visibility exclusively using clicks and keyboard", async () => {
  open(`/sales/products/${product.id}?step=review`);
  const privateChoice = await screen.findByRole("radio", { name: "Private" });
  const publicChoice = screen.getByRole("radio", { name: "Public" });
  fireEvent.click(privateChoice); fireEvent.click(publicChoice);
  expect(publicChoice).toBeChecked(); expect(privateChoice).not.toBeChecked();
  fireEvent.keyDown(publicChoice, { key: "ArrowLeft" });
  expect(privateChoice).toBeChecked(); expect(privateChoice).toHaveFocus(); expect(publicChoice).not.toBeChecked();
  expect(mocks.prepare).not.toHaveBeenCalled();
});


it("reviews and saves a title change without preparing a transaction", async () => {
  registered = true; product.visibility = "public"; open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Edit offer" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated title" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(await screen.findByRole("heading", { name: "Current offer" })).toBeInTheDocument();
  expect(product.title).toBe("Example offer");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("heading", { name: "Offer details saved" })).toBeInTheDocument();
  expect(product.title).toBe("Updated title"); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("routes price changes through transaction review and keeps current terms in the overview", async () => {
  registered = true; product.visibility = "public"; open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Edit offer" }));
  fireEvent.change(screen.getByLabelText("Price"), { target: { value: "2000" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
  expect(await screen.findByRole("heading", { name: "Update offer" })).toBeInTheDocument();
  expect(await screen.findByRole("dialog", { name: "Update offer" })).toHaveTextContent("Simulate confirmation");
  expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ kind: "update" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to offer" }));
  expect(screen.getByText(/Saved changes have not been applied/)).toBeInTheDocument();
});
it("saves visibility separately without a transaction", async () => {
  registered = true; product.visibility = "public"; open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Private" }));
  fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
  expect(await screen.findByText("Visibility updated")).toBeInTheDocument();
  expect(product.visibility).toBe("hidden"); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("requires confirmation before preparing a sales pause", async () => {
  registered = true; product.visibility = "public"; open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Pause sales" }));
  expect(screen.getByRole("dialog", { name: "Pause sales?" })).toBeInTheDocument(); expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ kind: "disable", disabled: true })));
});

it("resumes a pending management transaction instead of exposing editable settings", async () => {
  registered = true; product.visibility = "public";
  mocks.list.mockResolvedValue([{ ...publication("checking"), publication: undefined, action: { kind: "update", productId: product.id, receiving: config.sellerReceiving } }]);
  mocks.matches.mockReturnValue(false);
  open(`/sales/products/${product.id}`);
  expect(await screen.findByRole("heading", { name: "Update offer" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit offer" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back to offer" })).not.toBeInTheDocument();
});
it("preserves staged price changes when preparation fails and allows retry", async () => {
  registered = true; product.visibility = "public"; mocks.prepare.mockRejectedValueOnce(new Error("RPC unavailable"));
  open(`/sales/products/${product.id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Edit offer" }));
  fireEvent.change(screen.getByLabelText("Price"), { target: { value: "2000" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("RPC unavailable");
  expect(product.draftTerms!.price).toBe("2000");
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
  expect(await screen.findByRole("heading", { name: "Update offer" })).toBeInTheDocument();
});
