import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { PublicOrder } from "../commerce/client";
import type { Operation } from "../commerce/purchase-journal";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), list: vi.fn(), remove: vi.fn() }));
vi.mock("../commerce/client", async original => ({ ...await original<typeof import("../commerce/client")>(), useCommerce: () => ({ read: mocks.read, request: mocks.request }), useCommerceAccess: () => ({ address: `0x${"11".repeat(20)}`, authenticated: false }) }));
vi.mock("../commerce/ui", async original => ({ ...await original<typeof import("../commerce/ui")>(), journal: { list: mocks.list, remove: mocks.remove } }));
import { Purchases, purchaseStatus } from "../commerce/Purchases";
const account = `0x${"11".repeat(20)}`, contract = `0x${"22".repeat(20)}`, token = "0x534b2f3a21130d7a60830c2df862319e593943a3";
function order(orderId = "40", state = 1): PublicOrder { return { orderId, canceled: false, block: { number: 1, hash: "0x", timestamp: 100 }, order: { state, buyer: account, seller: contract, terms: { token, price: "1000000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", responseWindow: "259200", commitmentWindow: "600" }, publicationDeadline: "200", reviewDeadline: "200", responseDeadline: "200" }, offer: { id: "offer", title: "Test offer", description: "Content" } }; }
function operation(id: string, progress: Operation["progress"], orderId?: string): Operation { return { id, requestId: id, account, deployment: { chainId: 10143, contract }, productId: "offer", progress, orderId, hashes: [], version: 1 }; }
function open() { render(<MemoryRouter><Purchases /></MemoryRouter>); }
it("keeps purchases and token amounts visible while refreshing, including on failure", async () => {
  open();
  expect(await screen.findByText("1 USDC")).toBeInTheDocument();
  const card = screen.getByRole("link", { name: "Open order #40" }).closest("article");
  let fail!: (error: Error) => void;
  mocks.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const refresh = screen.getByRole("button", { name: "Refresh" });
  fireEvent.click(refresh);
  expect(refresh).toHaveAttribute("aria-busy", "true");
  expect(refresh.querySelector("svg.spin")).toBeInTheDocument();
  expect(refresh).toBeDisabled();
  expect(screen.queryByText("Working...")).not.toBeInTheDocument();
  expect(screen.queryByText("Loading amount...")).not.toBeInTheDocument();
  expect(screen.getByText("1 USDC")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open order #40" }).closest("article")).toBe(card);
  fail(new Error("Refresh unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Refresh unavailable");
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(refresh.querySelector("svg.spin")).not.toBeInTheDocument();
  expect(screen.getByText("1 USDC")).toBeInTheDocument();
});
it("keeps the empty purchases state visible during refresh", async () => {
  mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { chainId: 10143, contract } : { items: [], nextCursor: null });
  open();
  const empty = await screen.findByRole("heading", { name: "No purchases yet" });
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refresh = screen.getByRole("button", { name: "Refresh" });
  fireEvent.click(refresh);
  expect(empty).toBeInTheDocument();
  expect(screen.queryByText("Working...")).not.toBeInTheDocument();
  finish({ items: [], nextCursor: null });
  await waitFor(() => expect(refresh).toBeEnabled());
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.remove.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { chainId: 10143, contract } : path.startsWith("/public/assets/") ? { symbol: "USDC", decimals: 6 } : { items: [order()], nextCursor: null, indexing: { status: "available" } });
});
it("shows each unfinished offer's title and thumbnail and removes only the confirmed local checkout", async () => {
  mocks.list.mockResolvedValue([operation("first", "draft"), { ...operation("second", "reverted"), productId: "offer-2" }]);
  mocks.read.mockImplementation(async (path: string) => {
    if (path === "/deployment") return { chainId: 10143, contract };
    if (path === "/products/offer") return { id: "offer", title: "First offer", images: [{ id: "image-1", url: "/first", thumbnailUrl: "/first-thumb", width: 200, height: 150 }] };
    if (path === "/products/offer-2") return { id: "offer-2", title: "Second offer", images: [] };
    if (path.startsWith("/public/assets/")) return { symbol: "USDC", decimals: 6 };
    return { items: [order()], nextCursor: null };
  });
  open();
  const section = (await screen.findByRole("heading", { name: "Unfinished purchases" })).parentElement!;
  expect(await within(section).findByRole("heading", { name: "First offer" })).toBeInTheDocument();
  expect(within(section).getByRole("heading", { name: "Second offer" })).toBeInTheDocument();
  expect(within(section).getByRole("img", { name: "First offer" })).toHaveAttribute("src", "/first-thumb");
  fireEvent.click(within(section).getByRole("button", { name: "Remove checkout for First offer" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("First offer");
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove checkout" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "first" })));
  expect(within(section).queryByRole("heading", { name: "First offer" })).not.toBeInTheDocument();
  expect(within(section).getByRole("heading", { name: "Second offer" })).toBeInTheDocument();
});
it("keeps removal disabled while a purchase transaction is being checked", async () => {
  mocks.list.mockResolvedValue([operation("pending", "checking")]); open();
  expect(await screen.findByRole("button", { name: "Remove checkout for Offer unavailable" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Check status" })).toBeInTheDocument();
});
it("shows readable prices and hides finalized duplicates without authentication", async () => {
  mocks.list.mockResolvedValue([operation("one", "finalized", "40")]); open();
  expect(await screen.findByText("1 USDC")).toBeInTheDocument();
  expect(screen.getByText("Awaiting delivery")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Confirmed purchases" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Unfinished purchases" })).not.toBeInTheDocument();
  expect(screen.queryByText(/base units/)).not.toBeInTheDocument(); expect(mocks.request).not.toHaveBeenCalled();
});
it("shows the offer thumbnail on confirmed purchase cards", async () => {
  mocks.read.mockImplementation(async (path: string) => path === "/deployment" ? { chainId: 10143, contract }
    : path === "/products/offer" ? { id: "offer", title: "Test offer", images: [{ id: "image", url: "/cover", thumbnailUrl: "/cover-thumb", width: 200, height: 150 }] }
      : path.startsWith("/public/assets/") ? { symbol: "USDC", decimals: 6 } : { items: [order(), order("41")], nextCursor: null });
  open();
  expect((await screen.findAllByRole("img", { name: "Test offer" })).map(image => image.getAttribute("src"))).toEqual(["/cover-thumb", "/cover-thumb"]);
  expect(mocks.read.mock.calls.filter(([path]) => path === "/products/offer")).toHaveLength(1);
});
it("keeps a compact confirmed order until it appears and preserves unfinished checkout links", async () => {
  mocks.list.mockResolvedValue([operation("one", "finalized", "41"), operation("two", "checking"), operation("three", "draft")]); open();
  expect(await screen.findByText("Order #41 confirmed")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Check status" })).toHaveAttribute("href", "/products/offer");
  expect(screen.getByRole("link", { name: "Continue checkout" })).toHaveAttribute("href", "/products/offer");
  mocks.read.mockImplementation(async path => path === "/deployment" ? { chainId: 10143, contract } : path.startsWith("/public/assets/") ? { symbol: "USDC", decimals: 6 } : { items: [order(), order("41")], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByText("Order #41 confirmed")).not.toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Open order #41" })).toBeInTheDocument();
});
it("filters actionable and completed orders without hiding pagination", async () => {
  mocks.read.mockImplementation(async path => path === "/deployment" ? { chainId: 10143, contract } : path.startsWith("/public/assets/") ? { symbol: "USDC", decimals: 6 } : { items: [order("40", 1), order("41", 3), order("42", 9)], nextCursor: "42" }); open();
  await screen.findByRole("link", { name: "Open order #41" });
  fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
  expect(screen.getByRole("link", { name: "Open order #41" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open order #40" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "More purchases" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Completed" }));
  expect(screen.getByRole("link", { name: "Open order #42" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Unfinished purchases" })).not.toBeInTheDocument();
});
it("excludes operations from abandoned deployments", async () => {
  mocks.list.mockResolvedValue([{ ...operation("old", "checking"), deployment: { chainId: 10143, contract: account } }]); open();
  await screen.findByText("1 USDC"); expect(screen.queryByRole("link", { name: "Check status" })).not.toBeInTheDocument();
});
it("keeps order navigation when token metadata fails", async () => {
  mocks.read.mockImplementation(async path => { if (path.startsWith("/public/assets/")) throw Error("Unavailable"); return path === "/deployment" ? { chainId: 10143, contract } : { items: [order()], nextCursor: null }; }); open();
  expect(await screen.findByText("Amount unavailable")).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Open order #40" })).toBeInTheDocument();
});
it("shows only relevant actionable deadlines", () => {
  expect(purchaseStatus(order("1", 1)).deadline).toBeUndefined();
  expect(purchaseStatus(order("2", 3))).toMatchObject({ label: "Delivered", attention: true, deadlineLabel: "Review by", deadline: "200" });
  const expired = order("3", 3); expired.block.timestamp = 200;
  expect(purchaseStatus(expired)).toEqual({ label: "Review period ended", attention: false });
  const refund = order("4", 2); refund.canceled = true;
  expect(purchaseStatus(refund)).toEqual({ label: "Refund available", attention: true });
  const dispute = order("5", 4); dispute.block.timestamp = 200;
  expect(purchaseStatus(dispute)).toEqual({ label: "Seller response overdue", attention: true });
});
