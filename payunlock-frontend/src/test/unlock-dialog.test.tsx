import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  accounts: [] as string[],
  lastUsed: null as null | { address: string; kind: "password" | "passkey"; credentialId?: string; rpId?: string },
  unlock: vi.fn(), connect: vi.fn(), passkey: vi.fn(),
}));
vi.mock("@/wallet/vault", () => ({ WalletVault: class { list = async () => mocks.accounts; } }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: null, lastUsed: mocks.lastUsed, sessionEpoch: 0, busy: false, connectBuiltIn: mocks.connect }) }));
vi.mock("@/wallet/ApprovalProvider", () => ({ useApproval: () => async () => true }));
vi.mock("@/wallet/managed-session", () => ({ unlockWallet: mocks.unlock }));
vi.mock("@/wallet/passkey", () => ({ canUsePasskeys: () => true, openPasskeySession: mocks.passkey, passkeyError: () => "Passkey sign-in was not completed." }));
import { UnlockDialog } from "@/wallet/UnlockDialog";
import { saveAccountName } from "@/wallet/account-names";
import { rememberPasskeyAccount } from "@/wallet/saved-passkeys";

const first = `0x${"11".repeat(20)}`, second = `0x${"22".repeat(20)}`;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.accounts = [first, second]; mocks.lastUsed = { address: first, kind: "password" };
});
function mount(expectedAddress: string | null = null) {
  const onClose = vi.fn();
  render(<UnlockDialog open expectedAddress={expectedAddress} onClose={onClose} onConnected={vi.fn()} />);
  return onClose;
}

it("shows a remembered password account's name and password field immediately and signs in once", async () => {
  const name = "Personal account for shopping";
  saveAccountName(first, name);
  mocks.unlock.mockResolvedValue({ address: first });
  const close = mount();
  const password = await screen.findByLabelText("Password");
  expect(screen.getByTitle(name)).toHaveTextContent(`${name.slice(0, 18)}…`);
  expect(screen.queryByText("Address")).not.toBeInTheDocument();
  expect(mocks.unlock).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  fireEvent.change(password, { target: { value: "long account password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.unlock).toHaveBeenCalledWith(expect.anything(), first, "long account password", expect.any(Function));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});

it("switches to another named account and clears the previous password", async () => {
  saveAccountName(first, "Personal"); saveAccountName(second, "Work");
  mount();
  fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "do not carry this over" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose another account" }));
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  const card = screen.getByText("Work").closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Sign in" }));
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(screen.getByText("Work")).toBeInTheDocument();
});

it("offers direct passkey sign-in for a remembered named passkey", async () => {
  const account = { address: first, credentialId: "dGVzdA", rpId: window.location.hostname };
  rememberPasskeyAccount(account); saveAccountName(first, "Passkey wallet");
  mocks.lastUsed = { ...account, kind: "passkey" };
  mocks.passkey.mockResolvedValue({ address: first });
  mount();
  const signIn = await screen.findByRole("button", { name: "Sign in with passkey" });
  expect(screen.getByText("Passkey wallet")).toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  fireEvent.click(signIn);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.passkey).toHaveBeenCalledWith("signin", expect.any(Function), account);
});

it("keeps the chooser when the remembered wallet is unavailable and rejects the wrong account for an action", async () => {
  mocks.accounts = [second];
  const session = { address: second, dispose: vi.fn() };
  mocks.unlock.mockResolvedValue(session);
  mount(first);
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  fireEvent.click(signIn);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long account password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("alert");
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
});
