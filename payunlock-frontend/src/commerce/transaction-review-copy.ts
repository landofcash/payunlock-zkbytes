import type { Action } from "./client";

export function transactionReviewCopy(action?: Action) {
  switch (action?.kind) {
    case "approve": return { label: "Approve token payment", description: "Allow PayUnlock to collect exactly the purchase amount. Approval alone does not place an order." };
    case "purchase": return { label: "Confirm payment", description: "Pay for this offer and place your order." };
    case "claimRefund": case "refundDisputedOrder": return { label: "Confirm refund", description: "Return the full order payment to the buyer." };
    case "claimResponseTimeout": return { label: "Claim funds", description: "Release the order funds to the eligible participant after the response deadline." };
    case "withdrawSeller": return { label: "Claim payment", description: "Release the order payment to the seller." };
    case "confirmReceipt": return { label: "Accept delivery", description: "Make the order payment available to the seller.", warning: "Accepting delivery ends your ability to dispute this order. Continue only if you are satisfied." };
    case "reserveDelivery": case "reserveDeliveries": return { label: "Confirm delivery", description: "Commit the prepared delivery. Publication follows after confirmation." };
    case "publishDelivery": case "publishDeliveries": return { label: "Publish delivery", description: "Publish the prepared content for the buyer and start the review period." };
    case "openDispute": return { label: "Send problem report", description: "Send your encrypted problem report to the seller." };
    case "replyToDispute": return { label: "Send reply", description: "Send your prepared encrypted reply." };
    case "submitArbitrationEvidence": return { label: "Submit evidence", description: "Submit the prepared encrypted evidence for this case." };
    case "requestArbitrationEvidence": return { label: "Request evidence", description: "Send an encrypted evidence request to the selected participant." };
    case "requestArbitration": return { label: "Request arbitration", description: "Activate arbitration with the selected arbitrator. The arbitration fee is non-refundable." };
    case "approveArbitrationFee": return { label: "Approve arbitration fee", description: "Allow collection of the quoted arbitration fee. Approval alone does not activate arbitration." };
    case "resolveArbitration": return { label: "Confirm decision", description: action.sellerWins ? "Award the order payment to the seller." : "Award a full refund to the buyer.", warning: "This decision settles the case. Check the outcome before confirming." };
    case "cancelProduct": return { label: "Cancel offer", description: "Stop new purchases and make eligible orders refundable.", warning: "Cancellation is permanent. Published deliveries keep their existing rights." };
    case "refundCanceledOrders": return { label: "Confirm refunds", description: "Refund the selected eligible orders for this canceled offer." };
    case "create": return { label: "Publish offer", description: "Publish this offer and make it available for purchase." };
    case "update": return { label: "Confirm changes", description: "Apply the prepared changes to this offer." };
    case "disable": return { label: action.disabled ? "Pause sales" : "Resume sales", description: action.disabled ? "Pause new purchases for this offer." : "Make this offer available for purchase again." };
    case "claimFees": return { label: "Claim fees", description: "Transfer your accrued platform fees to your wallet." };
    case "addStorageService": return { label: "Register service", description: "Register the prepared storage service.", warning: "This registration cannot be undone or reassigned." };
    default: return { label: "Confirm changes", description: "Apply the prepared change. Check the summary before confirming." };
  }
}
