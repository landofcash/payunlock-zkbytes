import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { loadFrontendConfig } from "../config";

afterEach(() => vi.unstubAllGlobals());
it("validates API responses and keeps the preview non-payable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok", service: "payunlock-api" }) }));
  render(<MemoryRouter><App apiOrigin="http://127.0.0.1:4321" /></MemoryRouter>);
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Discover offers" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /buy|pay|connect wallet/i })).not.toBeInTheDocument();
});
it("shows API failure without breaking navigation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<MemoryRouter initialEntries={["/purchases"]}><App apiOrigin="http://127.0.0.1:4321" /></MemoryRouter>);
  expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Your purchases" })).toBeInTheDocument();
});
it("requires explicit chain and connector configuration", () => {
  const env = { VITE_API_ORIGIN: "http://127.0.0.1:4321", VITE_CHAIN_ID: "10143" };
  expect(loadFrontendConfig(env).VITE_WALLETS_ENABLED).toBe("false");
  expect(() => loadFrontendConfig({ ...env, VITE_CHAIN_ID: "143" })).toThrow("VITE_CHAIN_ID");
  expect(loadFrontendConfig({ ...env, VITE_WALLETS_ENABLED: "true" }).VITE_WALLETS_ENABLED).toBe("true");
  expect(() => loadFrontendConfig({ ...env, VITE_REOWN_PROJECT_ID: "invalid" })).toThrow("VITE_REOWN_PROJECT_ID");
});
