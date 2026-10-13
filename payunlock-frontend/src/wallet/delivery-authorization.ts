import {Interface} from "ethers";
import type {Approval} from "./managed-session";

const reference = "(uint32 serviceId,uint64 preparedAt,bytes32 creator,bytes buyerEnvelope,bytes sellerEnvelope,bytes32 contentHash)";
const abi = new Interface([`function reserveDeliveries(uint256[] ids)`, `function publishDeliveries(uint256[] ids,${reference}[] references)`]);
export type DeliveryAuthorization = {
  contract: string;
  messages: string[];
  commitments: Record<string, string>;
  references: Record<string, {
    serviceId: number;
    preparedAt: string;
    creator: string;
    buyerEnvelope: string;
    sellerEnvelope: string;
    contentHash: string
  }>
};

export function deliveryApproval(scope: DeliveryAuthorization): Approval {
  const approved: DeliveryAuthorization = structuredClone(scope);
  return async request => {
    if (request.kind === "message") return approved.messages.includes(request.message);
    if (request.kind !== "transaction") return false;
    const tx = request.transaction;
    if (tx.chainId !== 10143 || tx.to.toLowerCase() !== approved.contract.toLowerCase() || tx.value !== 0n || tx.gas > 30_000_000n) return false;
    try {
      const decoded = abi.parseTransaction({data: tx.data});
      if (!decoded || !["reserveDeliveries", "publishDeliveries"].includes(decoded.name)) return false;
      const ids = Array.from(decoded.args[0], String);
      if (!ids.length || ids.length > 30 || new Set(ids).size !== ids.length) return false;
      const expected = decoded.name === "reserveDeliveries" ? ids.map(id => approved.commitments[id]) : ids.map(id => approved.references[id]);
      if (expected.some(v => !v)) return false;
      return abi.encodeFunctionData(decoded.name, decoded.name === "reserveDeliveries" ? [ids] : [ids, expected]).toLowerCase() === tx.data.toLowerCase();
    } catch {
      return false;
    }
  };
}
