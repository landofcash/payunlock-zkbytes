import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), address: "0xadmin", authenticated: true }));
vi.mock("@/commerce/client", async importOriginal => ({ ...await importOriginal<typeof import("@/commerce/client")>(),
  useCommerce: () => ({ read: mocks.read, request: mocks.request }),
  useCommerceAccess: () => ({ address: mocks.address, authenticated: mocks.authenticated, busy: false, error: "", authorize: vi.fn() }),
}));
import { FeaturedAdmin, OfferAdmin } from "@/commerce/FeaturedAdmin";
const first = { id: "one", title: "First offer", description: "", revision: 1 };
const second = { id: "two", title: "Second offer", description: "", revision: 1 };
beforeEach(() => {
  mocks.address = "0xadmin"; mocks.authenticated = true;
  mocks.read.mockReset().mockResolvedValue({ owner: "0xadmin" });
  mocks.request.mockReset().mockResolvedValue({ version: "3", items: [first, second] });
});
it("reorders and removes selected offers locally, then saves their IDs and original version", async () => {
  render(<FeaturedAdmin />, { wrapper: MemoryRouter });
  await screen.findByRole("link", { name: /First offer/ });
  fireEvent.click(screen.getByRole("button", { name: "Move Second offer left" }));
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Second offer");
  expect(mocks.request).toHaveBeenCalledTimes(1);
  const remove = screen.getByRole("button", { name: "Remove First offer from featured" });
  expect(remove).toHaveTextContent(/^$/);
  expect(screen.getByRole("heading", { name: "First offer" })).toBeInTheDocument();
  fireEvent.click(remove);
  mocks.request.mockResolvedValueOnce({ version: "4", items: [second] });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("/admin/featured", { ids: ["two"], expectedVersion: "3" }, "PUT"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled());
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
it("preserves unsaved edits on conflict and allows reloading the current list", async () => {
  render(<FeaturedAdmin />, { wrapper: MemoryRouter });
  await screen.findByRole("link", { name: /First offer/ });
  fireEvent.click(screen.getByRole("button", { name: "Remove First offer from featured" }));
  mocks.request.mockRejectedValueOnce(new Error("Featured list changed. Reload the list."));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Reload the list");
  expect(screen.queryByRole("link", { name: /First offer/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reload list" }));
  expect(await screen.findByRole("link", { name: /First offer/ })).toBeInTheDocument();
});
it("does not request the admin list for a non-owner wallet", async () => {
  mocks.address = "0xother";
  render(<FeaturedAdmin />, { wrapper: MemoryRouter });
  expect(await screen.findByRole("alert")).toHaveTextContent("Only the platform administrator");
  expect(mocks.request).not.toHaveBeenCalled();
});
it("features from offer details and reloads the sanitized offer after restriction", async () => {
  const change = vi.fn();
  mocks.request.mockResolvedValue({ version: "3", restricted: false, frontpagePosition: null, visibility: "public" });
  render(<OfferAdmin product={first} onChange={change} />, { wrapper: MemoryRouter });
  await waitFor(() => expect(screen.getByRole("button", { name: "Add to featured" })).toBeEnabled());
  mocks.request.mockResolvedValueOnce({ version: "4", restricted: false, frontpagePosition: 1 });
  mocks.read.mockResolvedValue(first);
  fireEvent.click(screen.getByRole("button", { name: "Add to featured" }));
  await screen.findByText("Homepage position: 1");
  await waitFor(() => expect(change).toHaveBeenCalledWith(first));
  mocks.request.mockResolvedValueOnce({ version: "5", restricted: true, frontpagePosition: null });
  const restricted = { ...first, title: "Restricted offer", restricted: true };
  mocks.read.mockResolvedValue(restricted);
  fireEvent.click(screen.getByRole("button", { name: "Restrict offer" }));
  await waitFor(() => expect(change).toHaveBeenCalledWith(restricted));
  expect(mocks.request).toHaveBeenLastCalledWith("/admin/products/one", { expectedVersion: "4", restricted: true }, "PATCH");
  expect(screen.getByRole("button", { name: "Add to featured" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove restriction" })).toBeEnabled();
  expect(screen.getByRole("link", { name: "View original details" })).toHaveAttribute("href", "/admin/offers/one");
});
