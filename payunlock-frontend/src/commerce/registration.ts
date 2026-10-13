import {Interface} from "ethers";
import type {RegistrationConfiguration} from "./client";
import type {Operation} from "./purchase-journal";

const signature = "(bytes32 key,(address token,uint256 price,bool hasEventEnd,uint64 eventEnd,bool hasReviewOverride,uint64 reviewOverride,uint32 commitmentWindow) terms,(bytes32 nonce,bytes32 publicKey) receiving)";
const quoted = `${signature.slice(0, -1)},uint16 feeCapBps,uint256 expectedPlacementFee,uint64 expectedFeeVersion)`;
const iface = new Interface([`function createProduct${quoted}`, `function updateProduct${signature}`, "function setSalesDisabled(bytes32 key,bool disabled)"]);

export function registrationMatches(record: Operation, config: RegistrationConfiguration) {
  if (!record.transaction || !record.action || record.account !== config.seller || record.deployment.contract !== config.contract) return false;
  const action = record.action.kind;
  if (!["create", "update", "disable"].includes(action)) return false;
  try {
    const signatureName = action === "create" ? "createProduct" : action === "update" ? "updateProduct" : "setSalesDisabled";
    const result = iface.decodeFunctionData(signatureName, record.transaction.data);
    if (result.key !== config.productKey) return false;
    if (action === "disable") return config.status === (result.disabled ? 2 : 1);
    if (!config.productTerms || config.status === 0) return false;
    return Object.entries(config.productTerms).every(([key, value]) => String(result.terms[key]).toLowerCase() === String(value).toLowerCase()) && result.receiving.nonce === config.sellerReceiving.nonce && result.receiving.publicKey === config.sellerReceiving.publicKey &&
      (record.action.kind !== "create" || (Number(result.feeCapBps) === config.serviceFee.sellerCapBps && record.transaction.value === record.action.expectedPlacementFee));
  } catch {
    return false;
  }
}
