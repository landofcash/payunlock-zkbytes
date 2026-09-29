import { describe, expect, it } from "vitest";
import { Interface, keccak256 } from "ethers";
import { classifyActionLogs, classifyActionReceipt } from "../src/services/relayer-recovery.js";

const router = new Interface([
  "function executeAuthorized((address actor,bytes32 nonce,uint256 validAfter,uint256 validBefore) authorization,bytes actionData,bytes signature)",
  "event ActionExecuted(address indexed actor,bytes32 indexed nonce,bytes4 indexed selector,bytes32 actionHash)",
  "event ActionCanceled(address indexed actor,bytes32 indexed nonce)",
]);
const actor = `0x${"11".repeat(20)}`, nonce = `0x${"22".repeat(32)}`;
const action = "0x12345678", otherAction = "0x87654321";
const calldata = router.encodeFunctionData("executeAuthorized", [{ actor, nonce, validAfter: 0, validBefore: 1 }, action, "0x"]);
const executed = (data: string) => router.encodeEventLog(router.getEvent("ActionExecuted")!, [actor, nonce, data.slice(0, 10), keccak256(data)]);

describe("relayer action recovery", () => {
  it("accepts only the exact executed action for the queued nonce", () => {
    expect(classifyActionLogs(router, calldata, [executed(action)])).toBe("finalized");
    expect(classifyActionLogs(router, calldata, [executed(otherAction)])).toBe("failed");
  });
  it("treats a canceled nonce as failed and missing finalized logs as uncertain", () => {
    const canceled = router.encodeEventLog(router.getEvent("ActionCanceled")!, [actor, nonce]);
    expect(classifyActionLogs(router, calldata, [canceled])).toBe("failed");
    expect(classifyActionLogs(router, calldata, [])).toBeNull();
  });
  it("accepts a matching router event from the finalized transaction receipt", () => {
    const event = executed(action);
    const address = `0x${"33".repeat(20)}`;
    expect(classifyActionReceipt(router, calldata, actor, nonce, address, [{ address, ...event }])).toBe("finalized");
    expect(classifyActionReceipt(router, calldata, actor, nonce, address, [{ address: `0x${"44".repeat(20)}`, ...event }])).toBeNull();
    expect(classifyActionReceipt(router, calldata, actor, nonce, address, [{ address, ...router.encodeEventLog(router.getEvent("ActionExecuted")!, [`0x${"55".repeat(20)}`, nonce, action.slice(0, 10), keccak256(action)]) }])).toBeNull();
    expect(classifyActionReceipt(router, calldata, actor, nonce, address, [{ address, ...router.encodeEventLog(router.getEvent("ActionExecuted")!, [actor, `0x${"66".repeat(32)}`, action.slice(0, 10), keccak256(action)]) }])).toBeNull();
  });
});
