import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { loadFrontendConfig } from "../config";
import { SessionProvider } from "../wallet/session-store";

afterEach(() => vi.unstubAllGlobals());
it("validates API responses and shows the catalog without signing", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/health") ? ({ status: "ok", service: "payunlock-api" }) : ({ items: [], nextCursor: null }) })));
  render(<MemoryRouter><SessionProvider><App apiOrigin="http://127.0.0.1:4321" /></SessionProvider></MemoryRouter>);
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Top Offers" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /buy|pay|connect wallet/i })).not.toBeInTheDocument();
});
it("shows API failure without breaking navigation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<MemoryRouter initialEntries={["/purchases"]}><SessionProvider><App apiOrigin="http://127.0.0.1:4321" /></SessionProvider></MemoryRouter>);
  expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Your purchases" })).toBeInTheDocument();
});
it("opens the offer draft form without signing in", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/health") ? { status: "ok", service: "payunlock-api" } : url.endsWith("/platform") ? { minCommitmentWindow: 60, maxCommitmentWindow: 86400 } : url.includes("/balances") ? { items: [{ address: `0x${"00".repeat(20)}`, symbol: "MON", decimals: 18, allowed: true }], nextCursor: null, discoveryAvailable: true } : { reviewWindow: "86400" } })));
  render(<MemoryRouter initialEntries={["/create"]}><SessionProvider><App apiOrigin="http://127.0.0.1:4321" /></SessionProvider></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Create an offer" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review draft" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in to create offer" })).not.toBeInTheDocument();
});
it("requires explicit chain and connector configuration", () => {
  const env = { VITE_API_ORIGIN: "http://127.0.0.1:4321", VITE_CHAIN_ID: "10143" };
  expect(loadFrontendConfig(env).VITE_WALLETS_ENABLED).toBe("false");
  expect(() => loadFrontendConfig({ ...env, VITE_CHAIN_ID: "143" })).toThrow("VITE_CHAIN_ID");
  expect(loadFrontendConfig({ ...env, VITE_WALLETS_ENABLED: "true" }).VITE_WALLETS_ENABLED).toBe("true");
  expect(() => loadFrontendConfig({ ...env, VITE_REOWN_PROJECT_ID: "invalid" })).toThrow("VITE_REOWN_PROJECT_ID");
});
