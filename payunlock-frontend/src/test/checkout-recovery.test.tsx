import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Operation } from "../commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), send: vi.fn() }));
vi.mock("../commerce/client", () => ({ useCommerce: () => ({ request: mocks.request, read: mocks.read }) }));
vi.mock("../wallet/session-store", () => ({ useSession: () => ({ busy: false, runOperation: (fn: (session: unknown, current: () => boolean) => unknown) => fn({ address: `0x${"11".repeat(20)}`, sendTransaction: mocks.send }, () => true) }) }));
import { journal, TransactionPanel } from "../commerce/ui";
const account = `0x${"11".repeat(20)}`, contract = `0x${"22".repeat(20)}`, hash = `0x${"33".repeat(32)}`;
const record = (): Operation => { const id = crypto.randomUUID(); return { id, requestId: id, account, deployment: { chainId: 10143, contract }, receiving: { nonce: hash, publicKey: hash }, progress: "checking", activeHash: hash, hashes: [hash], version: 0, action: { kind: "purchase", requestId: id, expectedTerms: hash }, transaction: { chainId: 10143, to: contract, data: "0x", value: "1", gas: "100000", maxFeePerGas: "2", maxPriorityFeePerGas: "1", nonce: 0, balance: "1000000" } }; };
beforeEach(() => { mocks.read.mockResolvedValue({ chainId: 10143, contract }); mocks.request.mockReset(); mocks.send.mockReset(); });
it.each(["uncertain", "provisional", "finalized_success"])("keeps purchase %s receipts pending until canonical request recovery finds the order", async status => {
  const saved = await journal.save(record()), changed = vi.fn();
  mocks.request.mockImplementation(async (path: string) => path.includes("recover") ? { status: "uncertain" } : { status });
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  expect(changed).not.toHaveBeenCalled(); expect(screen.getByText("Checking transaction")).toBeInTheDocument();
});
it("recovers a replacement or lost-hash purchase from its original request", async () => {
  const saved = await journal.save({ ...record(), hashes: [] }), changed = vi.fn();
  mocks.request.mockResolvedValue({ status: "finalized", orderId: "42", order: { buyer: account, requestId: saved.requestId, buyerReceiving: saved.receiving } });
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ requestId: saved.requestId, orderId: "42", progress: "finalized" })));
});
it("persists checking before a broadcast whose response is lost", async () => {
  const saved = await journal.save({ ...record(), progress: "review", hashes: [] }), changed = vi.fn();
  mocks.request.mockResolvedValue(saved.transaction);
  mocks.send.mockImplementation(async () => {
    expect((await journal.list(account)).find(r => r.id === saved.id)?.progress).toBe("checking");
    throw new Error("Response lost");
  });
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send transaction" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
  expect((await journal.list(account)).find(r => r.id === saved.id)).toMatchObject({ requestId: saved.requestId, progress: "checking", hashes: [] });
});
it("allows the same reviewed operation after an explicit wallet rejection without treating lost responses as rejection", async () => {
  const saved = await journal.save({ ...record(), progress: "review", hashes: [] }), changed = vi.fn();
  mocks.request.mockResolvedValue(saved.transaction);
  mocks.send.mockRejectedValue(Object.assign(new Error("User rejected"), { code: 4001 }));
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send transaction" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("User rejected");
  expect((await journal.list(account)).find(r => r.id === saved.id)).toMatchObject({ requestId: saved.requestId, progress: "review", hashes: [] });
});
it("does not reuse a previous successful action hash after a new action loses its response", async () => {
  const saved = await journal.save({ ...record(), requestId: undefined, activeHash: undefined, action: { kind: "disable", productId: "product", disabled: true } }), changed = vi.fn();
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled());
  expect(mocks.request).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it("rejects pending operations from an abandoned deployment before recovery or signing", async () => {
  const saved = await journal.save(record());
  mocks.read.mockResolvedValue({ chainId: 10143, contract: `0x${"aa".repeat(20)}` });
  render(<MemoryRouter><TransactionPanel record={saved} onChange={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("abandoned deployment");
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["draft", "review", "reverted", "finalized"] as const)("hides manual status checks for %s operations", progress => {
  render(<MemoryRouter><TransactionPanel record={{ ...record(), progress }} onChange={vi.fn()} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
});

it("retains publication transaction details after confirmation for visibility recovery", async () => {
  const original = { ...record(), requestId: undefined, action: { kind: "create" as const, productId: "offer", receiving: { nonce: hash, publicKey: hash } }, publication: { visibility: "hidden" as const, revision: 1 } };
  const saved = await journal.save(original), changed = vi.fn(), finalized = vi.fn();
  mocks.request.mockResolvedValue({ status: "finalized_success" });
  render(<MemoryRouter><TransactionPanel record={saved} onChange={changed} onFinalized={finalized} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(finalized).toHaveBeenCalled());
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ progress: "finalized", transaction: original.transaction, publication: original.publication }));
});
