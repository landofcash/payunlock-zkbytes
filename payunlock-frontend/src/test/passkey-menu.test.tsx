import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), supported: true, accounts: [] as string[], open: vi.fn(), create: vi.fn(), connect: vi.fn(), session: null as null | { kind: string; address: string; chainId: string; passkey: { credentialId: string; rpId: string } }, backup: vi.fn() }));
vi.mock("@/wallet/passkey", () => ({ canUsePasskeys: () => mocks.supported, openPasskeySession: mocks.open, exportPasskeySecret: mocks.backup, passkeyError: () => "Passkey not completed. Use password instead or retry." }));
vi.mock("@/wallet/vault", () => ({ VAULT_EVENT: "test-vault", VAULT_CHANGE_KEY: "test-change", WalletVault: class {
  selected = async () => null; list = async () => mocks.accounts; create = mocks.create;
} }));
vi.mock("@/wallet/ApprovalProvider", () => ({ useApproval: () => async () => true }));
vi.mock("@/wallet/WalletBalances", () => ({ WalletBalances: () => null }));
vi.mock("@/commerce/client", () => ({ useCommerce: () => ({ read: mocks.read }), useCommerceAccess: () => ({ address: mocks.session?.address, signOut: vi.fn() }) }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: mocks.session, sessionEpoch: 0, busy: false, connectBuiltIn: mocks.connect, identities: [] }) }));
import { WalletMenu } from "@/wallet/WalletPage";
import { PASSKEY_ACCOUNTS_KEY, rememberPasskeyAccount } from "@/wallet/saved-passkeys";
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.supported = true; mocks.session = null; mocks.accounts = [];
  mocks.read.mockResolvedValue({ owner: `0x${"11".repeat(20)}` });
  // jsdom's UA stylesheet hides [popover] even with the shared API shim.
  HTMLElement.prototype.showPopover = function () { this.hidden = false; this.style.display = "block"; this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" })); };
  HTMLElement.prototype.hidePopover = function () { this.hidden = true; this.style.display = "none"; this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" })); };
});

it.each([true, false])("shows Top Offers below Settings only for the connected admin (admin=%s)", async admin => {
  mocks.session = { kind: "builtin", address: `0x${(admin ? "11" : "22").repeat(20)}`, chainId: "0x279f", passkey: { credentialId: "test", rpId: "example.test" } };
  render(<MemoryRouter><WalletMenu /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("/platform"));
  if (admin) {
    const link = await screen.findByRole("link", { name: "Top Offers" });
    expect(link).toHaveAttribute("href", "/admin/featured");
    expect(screen.getByRole("link", { name: "Settings" }).compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const restricted = screen.getByRole("link", { name: "Restricted Offers" });
    expect(restricted).toHaveAttribute("href", "/admin/restricted");
    expect(link.compareDocumentPosition(restricted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(link);
    expect(screen.queryByRole("dialog", { name: "Wallet" })).not.toBeInTheDocument();
  } else {
    await waitFor(() => expect(screen.queryByRole("link", { name: "Top Offers" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Restricted Offers" })).not.toBeInTheDocument();
  }
});

it("lists a previously used passkey, signs in to that account, and keeps discovery after the list is cleared", async () => {
  const account = { address: `0x${"11".repeat(20)}`, credentialId: "dGVzdA", rpId: window.location.hostname };
  rememberPasskeyAccount(account);
  mocks.open.mockResolvedValue({ lock: vi.fn() });
  await showMenu();
  expect(screen.getByText("· Passkey")).toBeInTheDocument();
  expect(screen.getByText("1 saved")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sign in to passkey account 0x111111...111111" }));
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.open).toHaveBeenCalledWith("signin", expect.any(Function), account);
  act(() => { localStorage.removeItem(PASSKEY_ACCOUNTS_KEY); window.dispatchEvent(new StorageEvent("storage", { key: PASSKEY_ACCOUNTS_KEY })); });
  expect(screen.queryByText("· Passkey")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled();
});
async function showMenu() {
  render(<MemoryRouter><WalletMenu /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText("Loading accounts...")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

it("renames password and passkey accounts and restores their names after remount", async () => {
  mocks.accounts = [`0x${"22".repeat(20)}`];
  rememberPasskeyAccount({ address: `0x${"11".repeat(20)}`, credentialId: "dGVzdA", rpId: window.location.hostname });
  await showMenu();
  fireEvent.click(screen.getByRole("button", { name: "Rename Account 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Account name" }), { target: { value: "Personal" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename Account 2" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Account name" }), { target: { value: "Passkey wallet" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  cleanup();
  await showMenu();
  expect(screen.getByText("Personal")).toBeInTheDocument();
  expect(screen.getByText("Passkey wallet")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Rename Personal" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Account name" }), { target: { value: "Discard this" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Personal")).toBeInTheDocument();
  expect(screen.queryByText("Discard this")).not.toBeInTheDocument();
});

it("prefers passkey creation, does not silently fall back on cancellation, and offers explicit password creation", async () => {
  mocks.open.mockRejectedValueOnce(new Error("cancelled"));
  await showMenu();
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
  await screen.findByText("Passkey not completed. Use password instead or retry.");
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use password instead" }));
  expect(screen.getByLabelText("Password")).toBeInTheDocument();
  expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
});

it("offers password creation directly when WebAuthn is unavailable and retains imports", async () => {
  mocks.supported = false;
  await showMenu();
  expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
  expect(screen.getByLabelText("Password")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(screen.getByLabelText("Recovery phrase")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Private key" }));
  expect(screen.getByLabelText("Private key")).toBeInTheDocument();
});

it("signs in without saved accounts and discards a late ceremony result after leaving the page", async () => {
  let resolve!: (value: unknown) => void;
  const session = { lock: vi.fn() };
  mocks.open.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await showMenu();
  fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
  act(() => window.dispatchEvent(new Event("pagehide")));
  await act(async () => resolve(session));
  expect(session.lock).toHaveBeenCalledOnce(); expect(mocks.connect).not.toHaveBeenCalled();
});

it("reauthenticates a passkey for backup without asking for a local password", async () => {
  const address = `0x${"11".repeat(20)}`;
  mocks.session = { kind: "builtin", address, chainId: "0x279f", passkey: { credentialId: "test", rpId: "example.test" } };
  mocks.backup.mockResolvedValueOnce({ mnemonic: "test recovery phrase", privateKey: "test private key" });
  render(<MemoryRouter><WalletMenu /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText("Loading accounts...")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back up account" }));
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Prepare recovery backup" }));
  await screen.findByRole("button", { name: "Show recovery material" });
  expect(mocks.backup).toHaveBeenCalledWith(mocks.session.passkey, address);
});
