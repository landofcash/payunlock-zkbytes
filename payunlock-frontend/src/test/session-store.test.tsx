import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "@/wallet/session-store";
import type { LabWalletSession, WalletSessionEvent } from "@/wallet/types";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  check: vi.fn(),
  derive: vi.fn(),
}));
vi.mock("@/exchange/identity", async (original) => ({
  ...(await original<typeof import("@/exchange/identity")>()),
  deriveIdentity: mocks.derive,
}));
vi.mock("@/wallet/metamask-adapter", () => ({
  metamaskAdapter: { connect: mocks.connect },
}));
vi.mock("@/wallet/compatibility", () => ({ checkCompatibility: mocks.check }));
function Probe() {
  const state = useSession();
  return (
    <>
      <button onClick={() => void state.connectMetaMask()}>Connect</button>
      <button
        disabled={state.busy}
        onClick={() => void state.testCompatibility()}
      >
        Check
      </button>
      <button disabled={state.busy} onClick={() => void state.disconnect()}>
        Disconnect
      </button>
      <output>
        {state.session?.address ?? "none"}|{state.compatibility}|
        {state.busy ? "busy" : "idle"}
      </output>
      <p>{state.error}</p>
      <button onClick={() => void state.restoreIdentity("personal")}>
        Restore
      </button>
      <button onClick={() => state.lockIdentities()}>Lock</button>
      <p data-testid="identities">
        {state.identities.map((item) => item.publicKey).join(",")}
      </p>
    </>
  );
}
describe("wallet session lifecycle", () => {
  let emit: (event: WalletSessionEvent) => void;
  let session: LabWalletSession;
  beforeEach(() => {
    vi.clearAllMocks();
    session = {
      kind: "metamask",
      walletName: "MetaMask",
      address: "account-a",
      transport: "managed",
      signMessage: vi.fn(),
      disconnect: vi.fn(),
      subscribe(listener) {
        emit = listener;
        return vi.fn();
      },
    };
    mocks.connect.mockResolvedValue(session);
    mocks.check.mockResolvedValue(true);
  });
  it("never connects on Strict Mode mount and locks duplicate connection requests", async () => {
    let resolve!: (value: LabWalletSession) => void;
    mocks.connect.mockReturnValue(
      new Promise<LabWalletSession>((done) => {
        resolve = done;
      }),
    );
    render(
      <StrictMode>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </StrictMode>,
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.dblClick(screen.getByText("Connect"));
    expect(mocks.connect).toHaveBeenCalledOnce();
    await act(async () => resolve(session));
  });
  it("wipes private bytes on account change and discards a late identity after lock", async () => {
    const privateKey = new Uint8Array(32).fill(7);
    mocks.derive.mockResolvedValue({
      label: "personal",
      publicKey: "public",
      privateKey,
    });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Connect"));
    await user.click(screen.getByText("Restore"));
    expect(mocks.check).not.toHaveBeenCalled();
    expect(screen.getByTestId("identities")).toHaveTextContent("public");
    act(() => emit("accountsChanged"));
    expect(privateKey.every((byte) => byte === 0)).toBe(true);
    expect(screen.getByTestId("identities")).toBeEmptyDOMElement();
    let resolve!: (value: unknown) => void;
    mocks.derive.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await user.click(screen.getByText("Restore"));
    await user.click(screen.getByText("Lock"));
    const lateKey = new Uint8Array(32).fill(8);
    await act(async () =>
      resolve({ label: "personal", publicKey: "late", privateKey: lateKey }),
    );
    expect(lateKey.every((byte) => byte === 0)).toBe(true);
    expect(screen.getByTestId("identities")).toBeEmptyDOMElement();
  });
  it("invalidates a late check after account change while retaining the prompt lock", async () => {
    let resolve!: (value: boolean) => void;
    mocks.check.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Connect"));
    await user.click(screen.getByText("Check"));
    act(() => {
      session.address = "account-b";
      emit("accountsChanged");
    });
    expect(screen.getByText("Check")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "account-b|untested|busy",
    );
    await act(async () => resolve(true));
    expect(screen.getByRole("status")).toHaveTextContent(
      "account-b|untested|idle",
    );
  });
  it("clears compatibility after disconnect and safely displays rejection", async () => {
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Connect"));
    await user.click(screen.getByText("Check"));
    expect(screen.getByRole("status")).toHaveTextContent("compatible");
    act(() => emit("disconnect"));
    expect(screen.getByRole("status")).toHaveTextContent("none|untested");
    mocks.connect.mockRejectedValue({
      code: 4001,
      message: "raw private data",
    });
    await user.click(screen.getByText("Connect"));
    await waitFor(() =>
      expect(screen.getByText(/Request declined/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/raw private data/)).not.toBeInTheDocument();
  });
  it("actively expires and wipes restored receiving keys without a status read", async () => {
    vi.useFakeTimers();
    try {
      const privateKey = new Uint8Array(32).fill(7);
      mocks.derive.mockResolvedValue({ label: "personal", publicKey: "public", privateKey });
      render(<SessionProvider><Probe /></SessionProvider>);
      await act(async () => { fireEvent.click(screen.getByText("Connect")); });
      await act(async () => { fireEvent.click(screen.getByText("Restore")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
      expect(privateKey.every(byte => byte === 0)).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent("none|untested|idle");
      expect(session.disconnect).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
