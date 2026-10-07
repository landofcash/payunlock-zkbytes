import { Interface, keccak256 } from "ethers";
import type { Approval } from "./managed-session";

const reference = "(uint32 serviceId,uint64 preparedAt,bytes32 creator,bytes buyerEnvelope,bytes sellerEnvelope,bytes32 contentHash)";
export const sellerDeliveryAbi = new Interface(["function reserveDelivery(uint256 id)", `function publishDelivery(uint256 id,${reference} contentRef)`]);
export const orderActionAbi = new Interface(["function withdrawSeller(uint256 id)", "function claimResponseTimeout(uint256 id)", "function confirmReceipt(uint256 id)"]);
export { DELIVERY_GAS_BOUND } from "../commerce/delivery-fees";
export type SellerAuthorization = {
  account: string; contract: string; calls: string[];
  payment: { kind: "sponsored"; router: string } | { kind: "self"; nonce: number; gas: bigint; maxFeePerGas: bigint };
};

export function sellerApproval(scope: SellerAuthorization): Approval {
  const approved = structuredClone(scope);
  return async request => {
    const data = approved.calls[0], payment = approved.payment;
    let matches = false;
    if (data && payment.kind === "self" && request.kind === "transaction") {
      const tx = request.transaction;
      matches = tx.chainId === 10143 && tx.to.toLowerCase() === approved.contract.toLowerCase() && tx.value === 0n &&
        tx.data.toLowerCase() === data.toLowerCase() && tx.nonce === payment.nonce && tx.gas > 0n && tx.gas <= payment.gas &&
        tx.maxFeePerGas <= payment.maxFeePerGas && tx.maxPriorityFeePerGas <= payment.maxFeePerGas;
    }
    if (data && payment.kind === "sponsored" && request.kind === "typedData") {
      const t = request.typedData, m = t.message;
      matches = t.domain.chainId === 10143 && t.domain.name === "PayUnlockActionRouter" && t.domain.version === "1" &&
        t.domain.verifyingContract.toLowerCase() === payment.router.toLowerCase() && t.primaryType === "PayUnlockAction" &&
        m.actor?.toLowerCase() === approved.account.toLowerCase() && m.escrow?.toLowerCase() === approved.contract.toLowerCase() &&
        m.actionHash === keccak256(data) && m.validAfter === "0" && BigInt(m.validBefore!) * 1000n > BigInt(Date.now()) &&
        BigInt(m.validBefore!) * 1000n <= BigInt(Date.now() + 3_600_000);
    }
    if (!matches) throw new Error("Delivery details or fees changed. Review the remaining delivery again.");
    approved.calls.shift();
    if (payment.kind === "self") payment.nonce++;
    return true;
  };
}
