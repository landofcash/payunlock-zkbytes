import {type Interface, keccak256, zeroPadValue} from "ethers";

type ActionLog = { data: string; topics: readonly string[] };
type ReceiptLog = ActionLog & { address: string };

export function classifyActionLogs(router: Interface, calldata: string | null, logs: readonly ActionLog[]): "finalized" | "failed" | null {
  const executedTopic = router.getEvent("ActionExecuted")!.topicHash;
  const canceledTopic = router.getEvent("ActionCanceled")!.topicHash;
  const expectedActionHash = calldata ? keccak256(router.decodeFunctionData("executeAuthorized", calldata)[1]) : null;
  for (const log of logs) {
    if (log.topics[0] === canceledTopic) return "failed";
    if (log.topics[0] === executedTopic) {
      const event = router.decodeEventLog("ActionExecuted", log.data, log.topics);
      return expectedActionHash && String(event.actionHash).toLowerCase() === expectedActionHash.toLowerCase() ? "finalized" : "failed";
    }
  }
  return null;
}

export function classifyActionReceipt(router: Interface, calldata: string | null, actor: string, nonce: string, routerAddress: string, logs: readonly ReceiptLog[]): "finalized" | "failed" | null {
  const actorTopic = zeroPadValue(actor, 32).toLowerCase();
  return classifyActionLogs(router, calldata, logs.filter(log => log.address.toLowerCase() === routerAddress.toLowerCase() &&
    log.topics[1]?.toLowerCase() === actorTopic && log.topics[2]?.toLowerCase() === nonce.toLowerCase()));
}
