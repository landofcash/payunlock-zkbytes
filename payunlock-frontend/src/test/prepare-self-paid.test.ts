import { expect, it, vi } from "vitest";
import { ApiError, type useCommerce } from "@/commerce/client";
import { prepareOperation } from "@/commerce/ui";
import type { Operation } from "@/commerce/purchase-journal";

it("reports insufficient MON on the self-paid path instead of preparing an unusable review", async () => {
  const request = vi.fn().mockRejectedValue(new ApiError("INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS")), read = vi.fn();
  const api = { request, read } as ReturnType<typeof useCommerce>;
  await expect(prepareOperation(api, {} as Operation, { kind: "approve", requestId: "request", expectedTerms: "terms" }, true)).rejects.toThrow("Not enough MON for network fees");
  expect(request).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
});
