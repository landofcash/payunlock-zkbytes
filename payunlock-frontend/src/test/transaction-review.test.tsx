import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { Wallet } from "ethers";
import { orderActionAbi } from "@/wallet/seller-authorization";
import { beforeEach, expect, it, vi } from "vitest";
import type { Operation } from "@/commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), save: vi.fn(), runOperation: vi.fn(), signed: vi.fn(), sent: vi.fn(), builtin: false }));
vi.mock("@/commerce/client", async original => ({ ...await original<typeof import("@/commerce/client")>(), useCommerce: () => ({ read: mocks.read, request: mocks.request }) }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: mocks.builtin ? { kind: "builtin", address: signer.address } : undefined, busy: false, runOperation: mocks.runOperation }) }));
import { ApiError, useCommerce } from "@/commerce/client";
import { TransactionPanel, journal, prepareOperation } from "@/commerce/ui";
import { OrderDialog } from "@/commerce/OrderPresentation";
const signer = new Wallet(`0x${"12".repeat(32)}`), contract = `0x${"22".repeat(20)}`, router = `0x${"33".repeat(20)}`;
const transaction = { chainId: 10143 as const, to: contract, data: "0x1234", value: "0", gas: "21000", nonce: 0, maxFeePerGas: "1000000000", maxPriorityFeePerGas: "100000000", balance: "1000000000000000000" };
function operation(changes: Partial<Operation> = {}): Operation { return { id: "review", account: signer.address.toLowerCase(), deployment: { chainId: 10143, contract }, orderId: "7", action: { kind: "claimRefund", orderId: "7" }, transaction, progress: "review", hashes: [], version: 1, ...changes }; }
function Harness({ initial }: { initial: Operation }) {
  const api = useCommerce();
  const [record, setRecord] = useState(initial), [open, setOpen] = useState(true);
  return open ? <OrderDialog title="Review refund" onClose={() => setOpen(false)}><TransactionPanel singleApproval={mocks.builtin} record={record} onChange={setRecord} onRetry={record.action ? async () => setRecord(await prepareOperation(api, record, record.action!)) : undefined} compactReview /></OrderDialog> : <p>Dialog closed</p>;
}
function mount(initial = operation(), path = "/purchases/7") { render(<MemoryRouter initialEntries={[path]}><Harness initial={initial} /></MemoryRouter>); }
beforeEach(() => {
  mocks.builtin = false; vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(journal, "save").mockImplementation(mocks.save);
  mocks.read.mockResolvedValue({ chainId: 10143, contract, router });
  mocks.save.mockImplementation(async record => ({ ...record, version: record.version + 1 }));
  mocks.request.mockImplementation(async (path: string) => path === "/transactions/prepare" ? transaction : path === "/transactions/request" ? { ...transaction } : path === "/relay/payments" ? { id: "relay-job" } : {});
  mocks.signed.mockImplementation(async data => signer.signTypedData(data.domain, data.types, data.message));
  mocks.sent.mockResolvedValue(`0x${"44".repeat(32)}`);
  mocks.runOperation.mockImplementation(async action => action({ address: signer.address, signTypedData: mocks.signed, sendTransaction: mocks.sent }, () => true));
});
it.each((['withdrawSeller', 'confirmReceipt'] as const).flatMap(kind => (['missing', 'accepted', 'settled'] as const).map(outcome => ({ kind, outcome }))))("checks a failed $kind relay submission before retrying ($outcome)", async ({ kind, outcome }) => {
  mocks.builtin = true;
  const action = { kind, orderId: '7' }, tx = { ...transaction, data: orderActionAbi.encodeFunctionData(kind, [7]) };
  const label = kind === 'confirmReceipt' ? 'Accept delivery' : 'Claim payment';
  let state = kind === 'confirmReceipt' ? 3 : 7, fail = true;
  mocks.request.mockImplementation(async (path: string) => {
    if (path === '/orders/7') return { order: { buyer: signer.address.toLowerCase(), seller: signer.address.toLowerCase(), state } };
    if (path === '/transactions/prepare' || path === '/transactions/request') return tx;
    if (path === '/relay/payments') { if (fail) throw new Error('Relay connection lost'); return { id: 'retry-job' }; }
    return {};
  });
  mocks.read.mockImplementation(async (path: string) => {
    if (path.startsWith('/relay/jobs/by-nonce/')) {
      if (outcome === 'accepted') return { id: 'original-job' };
      throw new ApiError('RELAY_JOB_NOT_FOUND');
    }
    return { chainId: 10143, contract, router };
  });
  mount(operation({ action, transaction: tx }), kind === 'confirmReceipt' ? '/purchases/7' : '/sales/orders/7');
  const confirm = await screen.findByRole('button', { name: label });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  const retry = await screen.findByRole('button', { name: 'Try again' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(await screen.findByText('Relay connection lost')).toBeInTheDocument();
  if (outcome === 'settled') state = kind === 'confirmReceipt' ? 7 : 8;
  fail = false; fireEvent.click(retry);
  if (outcome === 'missing') {
    const next = await screen.findByRole('button', { name: label });
    await waitFor(() => expect(next).toBeEnabled()); fireEvent.click(next);
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ relayJobId: 'retry-job' })));
    expect(mocks.request.mock.calls.filter(([path]) => path === '/relay/payments')).toHaveLength(2);
  } else {
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining(outcome === 'accepted' ? { relayJobId: 'original-job', progress: 'checking' } : { progress: 'finalized' })));
    expect(mocks.request.mock.calls.filter(([path]) => path === '/relay/payments')).toHaveLength(1);
  }
});
it("defaults to covered fees, allows switching both ways and keeps one confirmation action", async () => {
  mount();
  const toggle = await screen.findByRole("switch", { name: "Pay network fee myself" });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Network fee covered.")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Confirm refund" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Sign action for a relayer" })).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => { expect(toggle).toBeChecked(); expect(toggle).toBeEnabled(); });
  expect(screen.getByText("Maximum network fee")).toBeInTheDocument();
  expect(screen.getByText("0.000021 MON")).toBeInTheDocument();
  expect(screen.getByText("Transaction details").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(toggle);
  await waitFor(() => { expect(toggle).not.toBeChecked(); expect(toggle).toBeEnabled(); });
  expect(screen.queryByText("Maximum network fee")).not.toBeInTheDocument();
  expect(mocks.signed).not.toHaveBeenCalled(); expect(mocks.sent).not.toHaveBeenCalled();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeEnabled();
  });
  fireEvent.click(cancel);
  expect(await screen.findByText("Dialog closed")).toBeInTheDocument();
});
it("uses the signature path for the covered-fee confirmation", async () => {
  mount(); await screen.findByText("Network fee covered.");
  fireEvent.click(screen.getByRole("button", { name: "Confirm refund" }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/relay/payments", expect.objectContaining({ kind: "action" })));
  expect(mocks.signed).toHaveBeenCalledOnce(); expect(mocks.sent).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Check status" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm refund" })).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});
it("restores self-paid fees and uses the transaction path", async () => {
  mount(operation({ payNetworkFeeSelf: true }));
  await screen.findByRole("switch");
  expect(screen.getByRole("switch")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Confirm refund" }));
  await waitFor(() => expect(mocks.sent).toHaveBeenCalledOnce());
  expect(mocks.signed).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ progress: "checking", payNetworkFeeSelf: true }));
});
it("keeps covered fees selected when preparing self-payment fails", async () => {
  mocks.request.mockRejectedValueOnce(new ApiError("INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS"));
  mount(operation({ transaction: undefined }));
  fireEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not enough MON for network fees");
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(screen.getByText("Network fee covered.")).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("disables dismissal and duplicate submissions while waiting for the wallet", async () => {
  let finish!: () => void;
  mocks.runOperation.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mount(operation({ payNetworkFeeSelf: true })); await screen.findByRole("switch");
  fireEvent.click(screen.getByRole("button", { name: "Confirm refund" }));
  await waitFor(() => expect(mocks.runOperation).toHaveBeenCalled());
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Confirm refund" })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(dialog).toBeInTheDocument();
  finish(); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
});
it("leaves the review retryable when the wallet locks before signing", async () => {
  mocks.runOperation.mockRejectedValueOnce(new Error("Wallet is locked."));
  mount(operation({ payNetworkFeeSelf: true }));
  const confirm = await screen.findByRole("button", { name: "Confirm refund" });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await screen.findByText("Wallet is locked.");
  expect(confirm).toBeEnabled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.request.mock.calls.some(([path]) => path === "/transactions/broadcast")).toBe(false);
});
it.each(["checking", "reverted", "finalized"] as const)("does not offer another submission in the %s state", async progress => {
  mount(operation({ progress }));
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm refund" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeInTheDocument();
});
it("does not offer coverage for transactions that transfer MON", async () => {
  mount(operation({ transaction: { ...transaction, value: "1" } }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm refund" })).toBeEnabled());
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.getByText("You pay network fees in MON.")).toBeInTheDocument();
});
it("clears a known failed relay authorization before reviewing a retry", async () => {
  mount(operation({ progress: "reverted", relayNonce: "old-nonce", relayExpiresAt: "2099-01-01T00:00:00Z" }));
  fireEvent.click(screen.getByRole("button", { name: "Review again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm refund" })).toBeEnabled());
  expect(screen.getByRole("switch")).toBeEnabled();
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ progress: "review", relayNonce: undefined, relayExpiresAt: undefined }));
});

it.each([
  ["/purchases/7", "/purchases/7"],
  ["/sales/orders/7", "/sales/orders/7"],
  ["/arbitration/7", "/arbitration/7"],
])("links to the current order route from %s", (path, expected) => {
  mount(operation({ progress: "finalized" }), path);
  expect(screen.getByRole("link", { name: "Order #7" })).toHaveAttribute("href", expected);
});

it("omits an order link when the participant role is unknown", () => {
  mount(operation({ progress: "finalized" }), "/platform");
  expect(screen.queryByRole("link", { name: "Order #7" })).not.toBeInTheDocument();
});
