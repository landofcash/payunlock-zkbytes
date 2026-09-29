import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ZeroAddress } from "ethers";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/commerce/client", () => ({ useCommerce: () => ({ read: mocks.read }) }));
import { OfferFields, priceInUnits, durationInSeconds, localEventDate } from "@/commerce/OfferFields";
import type { Product } from "@/commerce/client";
const token = `0x${"11".repeat(20)}`;
beforeEach(() => mocks.read.mockResolvedValue({ discoveryAvailable: true, nextCursor: null, items: [
  { address: ZeroAddress, symbol: "MON", decimals: 18, allowed: true }, { address: token, symbol: "USDC", decimals: 6, allowed: true },
] }));
function Fixture() {
  const [form, setForm] = useState<Omit<Product, "id" | "revision">>({ title: "Offer", description: "", visibility: "draft", draftTerms: { token: ZeroAddress, price: "1000000000000000", eventEnd: null, reviewWindow: null, commitmentWindow: 600 } });
  const [valid, setValid] = useState(false);
  return <><OfferFields form={form} onChange={setForm} account={token} confirmed={false} defaultReview="86400" bounds={{ minCommitmentWindow: 60, maxCommitmentWindow: 86400 }} onValidity={setValid} /><output data-testid="terms">{JSON.stringify(form.draftTerms)}</output><button disabled={!valid}>Save</button></>;
}
it("converts prices exactly and rejects excess precision, zero and oversized values", () => {
  expect(priceInUnits("10.123456", 6)).toBe("10123456");
  expect(priceInUnits("0.000000000000000001", 18)).toBe("1");
  for (const value of ["0", "-1", "1e3", "1.0000001", (2n ** 256n).toString()]) expect(() => priceInUnits(value, 6)).toThrow();
  expect(durationInSeconds("1.5", 60)).toBe("90"); expect(durationInSeconds("0", 3600)).toBe("0");
  expect(() => durationInSeconds("0.001", 60)).toThrow();
});
it("selects tokens, keeps readable prices and serializes timing without exposing base units", async () => {
  render(<Fixture />);
  await waitFor(() => expect(screen.getByLabelText("Price (MON)")).toHaveValue("0.001"));
  fireEvent.click(screen.getByRole("button", { name: "Payment token" }));
  fireEvent.click(screen.getByRole("button", { name: "USDC" }));
  fireEvent.change(screen.getByLabelText("Price (USDC)"), { target: { value: "12.50" } });
  expect(screen.getByTestId("terms")).toHaveTextContent('"price":"12500000"');
  fireEvent.click(screen.getByText("Timing", { selector: "summary" }));
  fireEvent.change(screen.getByLabelText("Review period"), { target: { value: "custom" } });
  expect(screen.getByLabelText("Review duration")).toHaveValue("24");
  fireEvent.change(screen.getByLabelText("Review duration"), { target: { value: "2" } });
  expect(screen.getByTestId("terms")).toHaveTextContent('"reviewWindow":"7200"');
  fireEvent.change(screen.getByLabelText("Review period"), { target: { value: "default" } });
  expect(screen.getByTestId("terms")).toHaveTextContent('"reviewWindow":null');
  const date = "2027-05-20T14:30:00";
  fireEvent.change(screen.getByLabelText("Event end (optional)"), { target: { value: date } });
  expect(screen.getByTestId("terms")).toHaveTextContent(String(new Date(date).getTime() / 1000));
  expect(localEventDate(String(new Date(date).getTime() / 1000))).toBe(date);
  expect(screen.queryByLabelText("Price in exact base units")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Price (USDC)"), { target: { value: "0.0000001" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});
it("does not enable saving when token discovery is unavailable", async () => {
  mocks.read.mockResolvedValue({ discoveryAvailable: false, nextCursor: null, items: [] });
  render(<Fixture />); await screen.findByRole("button", { name: "Retry tokens" });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

it("keeps timing collapsed initially and opens separate help dialogs", async () => {
  render(<Fixture />);
  await screen.findByLabelText("Price (MON)");
  const timing = screen.getByText("Timing", { selector: "summary" }).closest("details");
  expect(timing).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("Timing", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "About event end" }));
  expect(screen.getByRole("dialog", { name: "Event end" })).toHaveTextContent("not a sales closing date");
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "About review period" }));
  expect(screen.getByRole("dialog", { name: "Review period" })).toHaveTextContent("zero review period");
  fireEvent.click(screen.getByRole("button", { name: "Close timing help" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
