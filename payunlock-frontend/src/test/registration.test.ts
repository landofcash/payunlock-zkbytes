import { Interface } from "ethers";
import { expect, it } from "vitest";
import { registrationMatches } from "../commerce/registration";
import type { RegistrationConfiguration } from "../commerce/client";
import type { Operation } from "../commerce/purchase-journal";
it("recovers lost registration hashes only from exactly matching finalized settings and identity", () => {
  const iface = new Interface(["function createProduct(bytes32,(address token,uint256 price,bool hasEventEnd,uint64 eventEnd,bool hasReviewOverride,uint64 reviewOverride,uint32 commitmentWindow),(bytes32 nonce,bytes32 publicKey),uint16,uint256,uint64)"]);
  const account = `0x${"11".repeat(20)}`, hash = `0x${"22".repeat(32)}`;
  const productTerms = { token: account, price: "100", hasEventEnd: false, eventEnd: "0", hasReviewOverride: true, reviewOverride: "0", commitmentWindow: "60" }, receiving = { nonce: hash, publicKey: hash };
  const configuration = { seller: account, contract: account, productKey: hash, productTerms, sellerReceiving: receiving, status: 1, serviceFee: { bps: 100, treasury: account, sellerCapBps: 200 } } as RegistrationConfiguration;
  const record = { account, deployment: { contract: account }, action: { kind: "create", feeCapBps: 200, expectedPlacementFee: "10", expectedFeeVersion: "1" }, transaction: { value: "10", data: iface.encodeFunctionData("createProduct", [hash, productTerms, receiving, 200, 10, 1]) } } as Operation;
  expect(registrationMatches(record, configuration)).toBe(true);
  expect(registrationMatches(record, { ...configuration, productTerms: { ...productTerms, hasReviewOverride: false } })).toBe(false);
  expect(registrationMatches(record, { ...configuration, sellerReceiving: { ...receiving, publicKey: `0x${"33".repeat(32)}` } })).toBe(false);
  expect(registrationMatches(record, { ...configuration, productTerms: { ...productTerms, price: "101" } })).toBe(false);
  expect(registrationMatches(record, { ...configuration, serviceFee: { ...configuration.serviceFee!, sellerCapBps: 300 } })).toBe(false);
});
