import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ZeroAddress } from "ethers";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/commerce/client", () => ({ useCommerce: () => ({ read: mocks.read }) }));
import { TopUpDialog } from "@/wallet/TopUpDialog";
import { WalletBalances } from "@/wallet/WalletBalances";
import { tokenPresentation } from "@/config/token-icons";
const address = `0x${"11".repeat(20)}`, token = `0x${"22".repeat(20)}`;
beforeEach(() => mocks.read.mockReset());
it("formats six-decimal balances and shows unavailable rather than zero for failed reads", async () => {
  mocks.read.mockResolvedValue({ chainId: 10143, nextCursor: null, incomplete: true, discoveryAvailable: true, items: [
    { address: ZeroAddress, symbol: "MON", balance: "1000000000000000000", decimals: 18, allowed: false },
    { address: token, symbol: "USDC", balance: "1234567", decimals: 6, allowed: true },
    { address, symbol: "Broken", balance: null, decimals: null, allowed: true },
  ] });
  render(<WalletBalances address={address} />);
  await screen.findByText("1.234567"); expect(screen.getByText("Gas only")).toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(tokenPresentation(10143, token).name).toBeUndefined();
  expect(tokenPresentation(1, ZeroAddress).name).toBeUndefined();
  expect(mocks.read).toHaveBeenCalledWith(`/public/wallets/${address}/balances`);
});
it("loads additional balances without duplicating MON", async () => {
  mocks.read.mockResolvedValueOnce({ chainId: 10143, items: [{ address: ZeroAddress, symbol: "MON", balance: "0", decimals: 18, allowed: true }], nextCursor: token, incomplete: false, discoveryAvailable: true });
  render(<WalletBalances address={address} />);
  await screen.findByRole("button", { name: "More tokens" });
  mocks.read.mockResolvedValueOnce({ chainId: 10143, items: [{ address: token, symbol: "TEST", balance: "1", decimals: 6, allowed: true }], nextCursor: null, incomplete: false, discoveryAvailable: true });
  fireEvent.click(screen.getByRole("button", { name: "More tokens" }));
  await screen.findByText("0.000001"); expect(screen.getAllByText("MON")).toHaveLength(1);
});
it("ignores a previous account's delayed response", async () => {
  let resolve!: (data: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(<WalletBalances address={address} />);
  mocks.read.mockResolvedValue({ chainId: 10143, items: [], nextCursor: null, incomplete: false, discoveryAvailable: true });
  view.rerender(<WalletBalances address={token} />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(`/public/wallets/${token}/balances`));
  resolve({ chainId: 10143, items: [{ address: ZeroAddress, symbol: "STALE", balance: "1", decimals: 18, allowed: true }] });
  await waitFor(() => expect(screen.queryByText("Loading balances…")).not.toBeInTheDocument());
  expect(screen.queryByText("STALE")).not.toBeInTheDocument();
});

it("uses chain-specific top-up links and disables tokens without a destination", async () => {
  mocks.read.mockResolvedValue({ chainId: 10143, nextCursor: null, incomplete: false, discoveryAvailable: true, items: [
    { address: ZeroAddress, symbol: "MON", balance: "0", decimals: 18, allowed: true },
    { address: "0x534b2f3a21130d7a60830c2df862319e593943a3", symbol: "USDC", balance: "0", decimals: 6, allowed: true },
    { address: token, symbol: "Unknown", balance: "0", decimals: 6, allowed: true },
  ] });
  render(<WalletBalances address={address} />);
  fireEvent.click(await screen.findByRole("button", { name: "Top up MON" }));
  expect(screen.getByRole("dialog", { name: "Top up MON" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy receiving address" })).toHaveTextContent(address);
  expect(screen.getByRole("link", { name: "Continue to Monad faucet" })).toHaveAttribute("href", "https://faucet.monad.xyz/");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Top up USDC" }));
  expect(screen.getByRole("link", { name: "Continue to Circle faucet" })).toHaveAttribute("href", "https://faucet.circle.com/");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Top up Unknown unavailable" })).toBeDisabled();
  expect(screen.queryByText("Add test MON")).not.toBeInTheDocument();
  expect(tokenPresentation(143, ZeroAddress).topUpProviders).toBeUndefined();
});

it("shows the full token address only in the hover or click tooltip", async () => {
  mocks.read.mockResolvedValue({ chainId: 10143, nextCursor: null, incomplete: false, discoveryAvailable: true, items: [{ address: token, symbol: "TEST", balance: "0", decimals: 6, allowed: true }] });
  render(<WalletBalances address={address} />);
  const label = await screen.findByRole("button", { name: "TEST token details" });
  expect(screen.queryByText(token)).not.toBeInTheDocument();
  fireEvent.mouseEnter(label);
  expect(screen.getByRole("tooltip")).toHaveTextContent(token);
  fireEvent.mouseLeave(label);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(label);
  expect(screen.getByRole("tooltip")).toHaveTextContent(token);
  fireEvent.keyDown(label, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("switches provider tabs and uses the receiving account in a configured exchange widget", () => {
  render(<TopUpDialog symbol="MON" address={address} chainId={143} onClose={vi.fn()} providers={[
    { id: "first", name: "First exchange", kind: "exchange", url: "https://example.invalid" },
    { id: "changelly", name: "Changelly", kind: "exchange", url: "https://changelly.com/", widget: { kind: "changelly", url: "https://widget.changelly.com/?from=btc&to=mon&merchant_id=test-fixture" } },
  ]} />);
  expect(screen.getByRole("tab", { name: "First exchange" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTitle("Changelly exchange")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("tab", { name: "First exchange" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Changelly" })).toHaveAttribute("aria-selected", "true");
  const url = new URL(screen.getByTitle("Changelly exchange").getAttribute("src")!);
  expect(url.searchParams.get("address")).toBe(address);
  expect(url.searchParams.get("to")).toBe("mon");
  expect(screen.getByRole("link", { name: "Continue to Changelly" })).toHaveAttribute("href", "https://changelly.com/");
});
