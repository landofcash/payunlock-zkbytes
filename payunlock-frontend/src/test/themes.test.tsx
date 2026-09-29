import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), account: `0x${"11".repeat(20)}` }));
vi.mock("@/commerce/client", () => ({ useCommerce: () => ({ read: mocks.read, request: mocks.request }), useCommerceAccess: () => ({ authenticated: true, authorize: vi.fn(), error: "" }) }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: { address: mocks.account }, sessionEpoch: 0, identityEpoch: 0, busy: false }) }));
import { ThemeProvider, ThemePicker, THEME_KEY, initialTheme } from "@/app/theme";
import { SellerEditor } from "@/commerce/Seller";
import { Fulfillment } from "@/commerce/Fulfillment";
import { Arbitration } from "@/commerce/Arbitration";
import { Platform } from "@/commerce/Platform";
import { protocolOrder, storageService } from "@/commerce/lifecycle";
import type { OrderView } from "@/commerce/client";
import { ApprovalProvider, useApproval } from "@/wallet/ApprovalProvider";
import { TransactionPanel } from "@/commerce/ui";
import type { Operation } from "@/commerce/purchase-journal";
const buyer = `0x${"11".repeat(20)}`, seller = `0x${"22".repeat(20)}`, arbitrator = `0x${"33".repeat(20)}`, hash = `0x${"44".repeat(32)}`;
const deployment = { chainId: 10143 as const, contract: `0x${"55".repeat(20)}` };
const view: OrderView = { orderId: "9876", block: { number: 1, hash, timestamp: 1 }, canceled: false, offer: { status: "public", title: "Test offer" }, eligibility: { openDispute: true }, order: { state: 3, buyer, seller, requestId: hash, productKey: hash, terms: { token: `0x${"00".repeat(20)}`, price: "1", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", responseWindow: "60", commitmentWindow: "600" }, buyerReceiving: { nonce: hash, publicKey: hash }, sellerReceiving: { nonce: hash, publicKey: hash }, deliveryHash: hash, publicationDeadline: "0", reviewDeadline: "0", responseDeadline: "0", turn: "0" } };
const assignment = { wallet: arbitrator, publicKey: hash, keyVersion: "1", revision: "2", fee: "1", requester: buyer, handoverRecorded: false };
const service = storageService({ id: 1, apiOrigin: "https://storage.test", downloadOrigin: "https://download.test", maxRetentionSeconds: 0 });
const order = protocolOrder(view, deployment);
beforeEach(() => {
 localStorage.clear(); mocks.account = buyer; mocks.read.mockReset(); mocks.request.mockReset();
 mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { ...deployment, reviewWindow: "86400" } : path === "/platform" ? { owner: buyer, minCommitmentWindow: 60, maxCommitmentWindow: 86400, batchLimit: 30, maxBatch: 30 } : path === "/storage-services" ? { items: [{ id: 1, label: "zkbytes" }] } : path.startsWith("/storage-service?") ? { id: 1, apiOrigin: "https://storage.test", downloadOrigin: "https://download.test", maxRetentionSeconds: 0 } : { items: [], nextCursor: null });
 mocks.request.mockResolvedValue({ items: [], nextCursor: null });
});
function mount(children: ReactNode) { return render(<MemoryRouter><ThemeProvider><ThemePicker />{children}</ThemeProvider></MemoryRouter>); }
function switchThemes(check: () => void) { for (const name of ["Terminal", "Cyberpunk", "Cosmic", "Light"]) { fireEvent.click(screen.getByRole("button", { name: /^Theme:/ })); fireEvent.click(screen.getByRole("button", { name: `${name} theme` })); expect(document.documentElement.dataset.theme).toBe(name.toLowerCase()); check(); } }
it("retains unsaved seller offer fields across all themes without another API read", async () => {
 mount(<SellerEditor />); await waitFor(() => expect(screen.queryByText("Working...")).not.toBeInTheDocument());
 const title = screen.getByRole("textbox", { name: "Title" }); fireEvent.change(title, { target: { value: "Unpublished offer" } });
 const reads = mocks.read.mock.calls.length;
 switchThemes(() => expect(title).toHaveValue("Unpublished offer")); expect(mocks.read).toHaveBeenCalledTimes(reads); expect(localStorage.getItem(THEME_KEY)).toBe("light");
});
it("retains unsent dispute text across all themes", async () => {
 mount(<Fulfillment view={view} refresh={async () => {}} />);
 await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/orders/9876/records"));
 await waitFor(() => expect(screen.getByRole("button", { name: "Report a problem" })).toBeEnabled());
 fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
 const dialog = screen.getByRole("dialog"), text = within(dialog).getByLabelText("Message");
 fireEvent.change(text, { target: { value: '<script>throw Error("never execute")</script>' } });
 switchThemes(() => expect(text).toHaveValue('<script>throw Error("never execute")</script>'));
 expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("retains participant evidence selection and reassignment handover fields", async () => {
 mount(<Arbitration view={{ ...view, order: { ...view.order, state: 6 }, assignment }} order={order} service={service} prepareAction={async () => {}} />);
 await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
 await waitFor(() => expect(screen.getByRole("button", { name: "Prepare or restore evidence" })).toBeEnabled());
 fireEvent.click(screen.getByRole("button", { name: "Prepare or restore evidence" }));
 const password = screen.getByLabelText("Evidence recovery passphrase");
 fireEvent.change(password, { target: { value: "evidence test password" } });
 await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
 switchThemes(() => { expect(screen.getByRole("group", { name: "Messages to include" })).toBeInTheDocument(); expect(screen.getByRole("group", { name: "Arbitrator requests to include" })).toBeInTheDocument(); expect(password).toHaveValue("evidence test password"); });
 expect(mocks.request).toHaveBeenCalledTimes(3);
});
it("retains arbitrator request instructions, recipient and advisory date", async () => {
 mocks.account = arbitrator;
 mount(<Arbitration view={{ ...view, order: { ...view.order, state: 6 }, eligibility: { resolveArbitration: true }, assignment }} order={order} service={service} prepareAction={async () => {}} />);
 await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
 await waitFor(() => expect(screen.getByRole("button", { name: "Request evidence" })).toBeEnabled());
 fireEvent.click(screen.getByRole("button", { name: "Request evidence" }));
 const instructions = screen.getByLabelText("Request instructions"), date = screen.getByLabelText("Suggested response date"), recipient = screen.getByRole("combobox", { name: "Request evidence from" });
 fireEvent.change(instructions, { target: { value: "Please include the original reply." } }); fireEvent.change(date, { target: { value: "2026-10-01T12:00" } }); fireEvent.change(recipient, { target: { value: seller } });
 switchThemes(() => { expect(instructions).toHaveValue("Please include the original reply."); expect(date).toHaveValue("2026-10-01T12:00"); expect(recipient).toHaveValue(seller); });
});
it("retains authorized admin replacement reason across theme changes", async () => {
 mocks.request.mockResolvedValue({ ...view, assignment }); mount(<Platform />);
 const id = await screen.findByLabelText("Order number"); fireEvent.change(id, { target: { value: "9876" } }); await waitFor(() => expect(screen.getByRole("button", { name: "Load assignment" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Load assignment" }));
 const reason = await screen.findByLabelText(/Reason for replacement/); fireEvent.change(reason, { target: { value: "Reviewed replacement requested by both parties" } });
 switchThemes(() => expect(reason).toHaveValue("Reviewed replacement requested by both parties"));
});
it("keeps an existing purchase request and receipt recovery mounted across themes", () => {
 const saved: Operation = { id: "test-purchase", requestId: hash, version: 0, account: buyer, deployment, receiving: { nonce: hash, publicKey: hash }, progress: "checking", hashes: [hash], activeHash: hash };
 const changed = vi.fn(); mount(<TransactionPanel record={saved} onChange={changed} />);
 const panel = screen.getByText("Checking transaction"); switchThemes(() => expect(screen.getByText("Checking transaction")).toBe(panel));
 expect(changed).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it("keeps a pending wallet approval open and resolves it only once", async () => {
 const done = vi.fn(); function Probe() { const approve = useApproval(); return <button onClick={() => { void approve({ kind: "message", message: "Test signature" }).then(done); }}>Request test approval</button>; }
 mount(<ApprovalProvider><Probe /></ApprovalProvider>); fireEvent.click(screen.getByText("Request test approval"));
 const dialog = await screen.findByRole("dialog"); switchThemes(() => expect(screen.getByRole("dialog")).toBe(dialog)); expect(done).not.toHaveBeenCalled();
 const details = screen.getByText("Signing details").closest("details")!;
 expect(details).not.toHaveAttribute("open");
 fireEvent.click(screen.getByText("Signing details")); expect(details).toHaveAttribute("open");
 fireEvent.click(screen.getByRole("button", { name: "Approve signature" })); await waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith(true));
 fireEvent.click(screen.getByText("Request test approval")); await screen.findByRole("dialog");
 expect(screen.getByText("Signing details").closest("details")).not.toHaveAttribute("open");
});
it("falls back safely for unknown or unavailable theme storage", () => {
 localStorage.setItem(THEME_KEY, "unknown"); expect(initialTheme()).toBe("light");
 const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("storage blocked"); });
 try { expect(initialTheme()).toBe("light"); } finally { spy.mockRestore(); }
});

it("checks payment token status without signing and clears it when the address changes", async () => {
 mount(<Platform />);
 const input = await screen.findByLabelText("Payment token address");
 fireEvent.change(input, { target: { value: seller } });
 await waitFor(() => expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled());
 mocks.read.mockResolvedValueOnce({ asset: seller, allowed: false });
 fireEvent.click(screen.getByRole("button", { name: "Check status" }));
 await screen.findByRole("button", { name: "Enable token" });
 expect(mocks.request).not.toHaveBeenCalled();
 fireEvent.change(input, { target: { value: arbitrator } });
 expect(screen.queryByRole("button", { name: "Enable token" })).not.toBeInTheDocument();
 mocks.read.mockResolvedValueOnce({ asset: arbitrator, allowed: true });
 fireEvent.click(screen.getByRole("button", { name: "Check status" }));
 await screen.findByRole("button", { name: "Disable token" });
});
it("hides payment token administration from non-owners", async () => {
 mocks.account = seller; mount(<Platform />);
 await screen.findByRole("heading", { name: "Receiving key" });
 await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("/platform"));
 expect(screen.queryByLabelText("Payment token address")).not.toBeInTheDocument();
});
