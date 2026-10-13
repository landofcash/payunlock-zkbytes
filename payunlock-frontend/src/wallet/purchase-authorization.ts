import type {Approval, ReviewedTransaction} from "./managed-session";
import type {ReviewedTypedData} from "./types";

export type PurchaseAuthorization = {
  transactions: { transaction: ReviewedTransaction; maxNetworkFee: bigint }[];
  typedData?: ReviewedTypedData;
};

// Only the exact reviewed payment may bypass the ordinary wallet dialog.
// Requests are consumed once; anything outside this scope stops checkout.
export function purchaseApproval(scope: PurchaseAuthorization): Approval {
  const approved = structuredClone(scope);
  return async request => {
    if (request.kind === "typedData" && approved.typedData && JSON.stringify(request.typedData) === JSON.stringify(approved.typedData)) {
      approved.typedData = undefined;
      return true;
    }
    if (request.kind === "transaction") {
      const entry = approved.transactions[0], tx = request.transaction;
      if (entry && tx.chainId === entry.transaction.chainId && tx.to.toLowerCase() === entry.transaction.to.toLowerCase() &&
        tx.data.toLowerCase() === entry.transaction.data.toLowerCase() && tx.value === entry.transaction.value && tx.nonce === entry.transaction.nonce &&
        tx.gas <= entry.transaction.gas && tx.maxFeePerGas <= entry.transaction.maxFeePerGas &&
        tx.maxPriorityFeePerGas <= entry.transaction.maxFeePerGas && tx.gas * tx.maxFeePerGas <= entry.maxNetworkFee) {
        approved.transactions.shift();
        return true;
      }
    }
    throw new Error("Payment details changed. Review the purchase again.");
  };
}
