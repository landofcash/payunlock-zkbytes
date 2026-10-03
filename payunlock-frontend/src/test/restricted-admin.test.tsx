import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), address: "0xadmin" }));
vi.mock("@/commerce/client", async importOriginal => ({ ...await importOriginal<typeof import("@/commerce/client")>(),
  useCommerce: () => ({ read: mocks.read, request: mocks.request }),
  useCommerceAccess: () => ({ address: mocks.address, authenticated: true, busy: false, error: "" }),
}));
import { RestrictedAdmin, RestrictedOfferPage } from "@/commerce/RestrictedAdmin";
const product = { id: "one", title: "Original workshop", description: "Original private description", restricted: true, revision: 2, visibility: "public" as const,
  seller: `0x${"11".repeat(20)}`, images: [{ id: "image", url: "/v1/media/image/image", thumbnailUrl: "/v1/media/image/thumbnail", width: 100, height: 100 }],
  draftTerms: { token: `0x${"00".repeat(20)}`, price: "1000000000000000", eventEnd: null, reviewWindow: null, commitmentWindow: 600 } };
const preview = { configuration: { terms: { ...product.draftTerms, hasEventEnd: false, eventEnd: "0", reviewWindow: "86400" } }, asset: { symbol: "MON", decimals: 18 } };
beforeEach(() => {
  mocks.address = "0xadmin";
  mocks.read.mockReset().mockResolvedValue({ owner: "0xadmin" });
  mocks.request.mockReset();
});
function details() {
  render(<MemoryRouter initialEntries={["/admin/offers/one"]}><Routes><Route path="/admin/offers/:id" element={<RestrictedOfferPage />} /></Routes></MemoryRouter>);
}
it("shows original restricted cards and paginates into original admin details", async () => {
  mocks.request.mockResolvedValueOnce({ items: [product], nextCursor: "one" });
  render(<RestrictedAdmin />, { wrapper: MemoryRouter });
  await screen.findByRole("heading", { name: product.title });
  expect(screen.getByRole("img", { name: product.title })).toHaveAttribute("src", product.images[0]!.thumbnailUrl);
  expect(screen.getByText(product.description)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open original details" })).toHaveAttribute("href", "/admin/offers/one");
  await waitFor(() => expect(screen.getByRole("button", { name: "More restricted offers" })).toBeEnabled());
  mocks.request.mockResolvedValueOnce({ items: [{ ...product, id: "two", title: "Second original" }], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "More restricted offers" }));
  await screen.findByRole("heading", { name: "Second original" });
  expect(mocks.request).toHaveBeenLastCalledWith("/admin/restricted?after=one");
  expect(screen.getByRole("heading", { name: product.title })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "More restricted offers" })).not.toBeInTheDocument();
});
it("loads original images, text and confirmed terms, then removes restriction with the current version", async () => {
  mocks.request.mockResolvedValueOnce({ product, version: "7", preview });
  details();
  await screen.findByRole("heading", { name: product.title });
  expect(screen.getByRole("img", { name: product.title })).toHaveAttribute("src", product.images[0]!.url);
  expect(screen.getByText(product.description)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Price")).toHaveTextContent("0.001 MON"));
  expect(screen.getByText("24 hours")).toBeInTheDocument();
  expect(screen.getByText("Restricted", { selector: ".order-badge" })).toBeInTheDocument();
  mocks.request.mockResolvedValueOnce({ version: "8", restricted: false }).mockResolvedValueOnce({ product: { ...product, restricted: false }, version: "8", preview });
  fireEvent.click(screen.getByRole("button", { name: "Remove restriction" }));
  expect(await screen.findByText("Unrestricted", { selector: ".order-badge" })).toBeInTheDocument();
  expect(mocks.request).toHaveBeenCalledWith("/admin/products/one", { expectedVersion: "7", restricted: false }, "PATCH");
  expect(screen.queryByRole("button", { name: "Remove restriction" })).not.toBeInTheDocument();
});
it("keeps original metadata readable when current sale terms are unavailable", async () => {
  mocks.request.mockResolvedValueOnce({ product: { ...product, visibility: "draft" }, version: "7", preview: null });
  details();
  await screen.findByRole("heading", { name: product.title });
  expect(screen.getByText(product.description)).toBeInTheDocument();
  expect(screen.getByText("Platform default")).toBeInTheDocument();
  expect(screen.getByText("600 seconds")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open public offer page" })).not.toBeInTheDocument();
});
it.each(["list", "details"])("does not fetch original metadata for a non-admin (%s)", async page => {
  mocks.address = "0xother";
  if (page === "list") render(<RestrictedAdmin />, { wrapper: MemoryRouter }); else details();
  expect(await screen.findByRole("alert")).toHaveTextContent("Only the platform administrator");
  expect(mocks.request).not.toHaveBeenCalled();
  expect(screen.queryByText(product.title)).not.toBeInTheDocument();
});
