import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ZeroAddress } from "ethers";

const owner = `0x${"11".repeat(20)}`, treasury = `0x${"22".repeat(20)}`, usdc = `0x${"33".repeat(20)}`, escrow = `0x${"44".repeat(20)}`;
const mocks = vi.hoisted(() => ({ account: "", read: vi.fn(), request: vi.fn(), list: vi.fn(), prepare: vi.fn() }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: { address: mocks.account }, sessionEpoch: 1, busy: false }) }));
vi.mock("@/commerce/client", () => ({ useCommerce: () => ({ read: mocks.read, request: mocks.request }) }));
vi.mock("@/commerce/ui", async importOriginal => {
  const original = await importOriginal<typeof import("@/commerce/ui")>();
  return { ...original, journal: { list: mocks.list }, prepareOperation: mocks.prepare, TransactionPanel: () => <div>Submit prepared change</div> };
});
import { Platform } from "@/commerce/Platform";

beforeEach(() => {
  mocks.account = owner;
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.prepare.mockReset().mockImplementation(async (_api, record, action) => ({ ...record, action, progress: "review" }));
  mocks.request.mockReset();
  mocks.read.mockReset().mockImplementation(async (path: string) => {
    if (path === "/platform") return { owner, feeTreasury: treasury, serviceFeeBps: 250, offerPlacementFee: "100000000000000000", arbitrationFeeAsset: usdc, reviewWindow: "86400", responseWindow: "3600", minResponseWindow: "1800", minCommitmentWindow: 3600, maxCommitmentWindow: 86400, batchLimit: 10, maxBatch: 50 };
    if (path === "/deployment") return { chainId: 10143, contract: escrow, router: owner, usdc };
    if (path.startsWith("/public/assets/")) return path.endsWith(ZeroAddress) ? { symbol: "MON", decimals: 18 } : { symbol: "USDC", decimals: 6 };
    if (path.startsWith("/arbitrators/")) return { active: false, fee: "0" };
    throw new Error(`Unexpected read: ${path}`);
  });
});

it("shows treasury claims only to the treasury and prefills readable settings for the owner", async () => {
  const view = render(<Platform />);
  await screen.findByRole("heading", { name: "Platform administration" });
  expect(screen.queryByRole("heading", { name: "Treasury" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Service fee (%)")).toHaveValue("2.5");
  expect(screen.getByLabelText("New placement fee (MON)")).toHaveValue("0.1");
  view.unmount();
  mocks.account = treasury;
  render(<Platform />);
  await screen.findByRole("heading", { name: "Treasury" });
  expect(screen.queryByRole("heading", { name: "Platform administration" })).not.toBeInTheDocument();
});

it("shows one action-scoped change summary when saving a setting", async () => {
  render(<Platform />);
  const field = await screen.findByLabelText("Service fee (%)");
  fireEvent.change(field, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save service fee" }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.anything(), { kind: "setServiceFee", bps: 300, treasury }));
  expect(await screen.findByRole("dialog", { name: "Change service fee" })).toBeInTheDocument();
  expect(screen.getByText("Submit prepared change")).toBeInTheDocument();
  expect(screen.queryByText("Review transaction")).not.toBeInTheDocument();
});

it("uses the order's recorded arbitration fee asset when displaying a replacement", async () => {
  mocks.request.mockResolvedValue({ assignmentFeeAsset: usdc, assignment: { wallet: owner, revision: "2", fee: "1500000" } });
  render(<Platform />);
  fireEvent.change(await screen.findByLabelText("Order number"), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Load assignment" }));
  expect(await screen.findByText(/original fee 1\.5 USDC/)).toBeInTheDocument();
  expect(mocks.request).toHaveBeenCalledWith("/admin/orders/42");
});
