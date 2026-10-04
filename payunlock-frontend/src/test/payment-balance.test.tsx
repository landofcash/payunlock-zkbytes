import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PaymentBalance } from "@/commerce/PaymentBalance";
import type { Asset, Configuration } from "@/commerce/client";
import { saveAccountName } from "@/wallet/account-names";

const address = `0x${"11".repeat(20)}`, token = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const configuration = { chainId: 10143, terms: { token, price: "1250000" } } as Configuration;
const asset: Asset = { token, symbol: "USDC", decimals: 6, balance: "21237500", nativeBalance: "1000000000000000000", allowance: "0" };
beforeEach(() => localStorage.clear());
function mount(overrides: Partial<Parameters<typeof PaymentBalance>[0]> = {}) {
  const handlers = { onRefresh: vi.fn(), onTopUp: vi.fn() };
  render(<PaymentBalance address={address} asset={asset} configuration={configuration} selfPay={false} busy={false} error="" {...handlers} {...overrides} />);
  return handlers;
}

it("shows the saved name, exact balance and purchase readiness without unrelated tokens", () => {
  const name = "Personal shopping account";
  saveAccountName(address, name);
  const handlers = mount();
  const details = screen.getByText("Your balance").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Your balance"));
  expect(details.open).toBe(true);
  expect(screen.getByTitle(name)).toHaveTextContent(`${name.slice(0, 18)}…`);
  expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  expect(screen.getByText("21.2375 USDC")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Purchase balance" })).toHaveTextContent("Enough for this purchase");
  expect(screen.queryByRole("group", { name: "MON balance" })).not.toBeInTheDocument();
  expect(screen.queryByText("Monad Testnet")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Top up USDC" }));
  expect(handlers.onTopUp).toHaveBeenCalledWith({ token, symbol: "USDC" });
});

it("shows the exact shortfall when the balance is insufficient", () => {
  mount({ asset: { ...asset, balance: "1000001" } });
  expect(screen.getByText("Your balance").closest("details")!.open).toBe(true);
  expect(screen.getByRole("status", { name: "Purchase balance" })).toHaveTextContent("You need another 0.249999 USDC");
  expect(screen.queryByText("Enough for this purchase")).not.toBeInTheDocument();
});

it("refreshes from the header without expanding a collapsed section and shows gas top-up for direct payment", () => {
  const handlers = mount({ selfPay: true });
  const details = screen.getByText("Your balance").closest("details")!;
  fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
  expect(handlers.onRefresh).toHaveBeenCalledOnce();
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Your balance"));
  expect(screen.getByRole("group", { name: "MON balance" })).toHaveTextContent("1.0 MON");
  fireEvent.click(screen.getByRole("button", { name: "Top up MON" }));
  expect(handlers.onTopUp).toHaveBeenCalledWith({ token: `0x${"00".repeat(20)}`, symbol: "MON" });
  expect(screen.queryByText("Network fee covered")).not.toBeInTheDocument();
});

it("keeps the fee choice inside the expandable balance and opens automatically after a shortfall", () => {
  const onChange = vi.fn();
  const props = { address, asset, configuration, selfPay: false, feeChoice: { disabled: false, onChange }, busy: false, error: "", onRefresh: vi.fn(), onTopUp: vi.fn() };
  const view = render(<PaymentBalance {...props} />);
  const details = screen.getByText("Your balance").closest("details")!;
  expect(details.open).toBe(false);
  expect(screen.getByRole("switch", { name: "Pay network fee myself" })).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Pay network fee myself" }).closest("details")).toBe(details);
  fireEvent.click(screen.getByText("Your balance"));
  const toggle = screen.getByRole("switch", { name: "Pay network fee myself" });
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByText("Your balance"));
  view.rerender(<PaymentBalance {...props} asset={{ ...asset, balance: "0" }} />);
  expect(details.open).toBe(true);
  expect(screen.getByRole("status", { name: "Purchase balance" })).toHaveTextContent("You need another 1.25 USDC");
});

it("does not show balances or readiness when the balance read fails", () => {
  mount({ asset: undefined, error: "Could not load balances. Refresh to try again." });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not load balances");
  expect(screen.queryByText("Enough for this purchase")).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "MON balance" })).not.toBeInTheDocument();
});

it("shows one MON row for a native-token order", () => {
  mount({ selfPay: true, configuration: { ...configuration, terms: { ...configuration.terms, token: `0x${"00".repeat(20)}` } }, asset: { ...asset, symbol: "MON", decimals: 18, balance: "1000000000000000000" } });
  expect(screen.getAllByRole("group", { name: "MON balance" })).toHaveLength(1);
});
