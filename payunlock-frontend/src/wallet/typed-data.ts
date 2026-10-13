import {formatUnits, getAddress} from "ethers";
import type {ReviewedTypedData} from "./types";

const receiveFields = [
  {name: "from", type: "address"}, {name: "to", type: "address"}, {name: "value", type: "uint256"},
  {name: "validAfter", type: "uint256"}, {name: "validBefore", type: "uint256"}, {name: "nonce", type: "bytes32"},
];

export function validateTokenAuthorization(request: ReviewedTypedData, account: string): ReviewedTypedData {
  const value = structuredClone(request);
  const message = value.message;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (value.primaryType === "PayUnlockAction") {
    const actionFields = [
      {name: "actor", type: "address"}, {name: "escrow", type: "address"}, {name: "actionHash", type: "bytes32"},
      {name: "nonce", type: "bytes32"}, {name: "validAfter", type: "uint256"}, {name: "validBefore", type: "uint256"},
    ];
    if (JSON.stringify(value.types) !== JSON.stringify({PayUnlockAction: actionFields}) || value.domain.name !== "PayUnlockActionRouter" ||
      value.domain.version !== "1" || value.domain.chainId !== 10143 || !/^0x[0-9a-fA-F]{40}$/.test(value.domain.verifyingContract) ||
      getAddress(message.actor ?? "") !== getAddress(account) || getAddress(message.escrow ?? "") !== getAddress(value.review.recipient) ||
      !/^0x[0-9a-fA-F]{64}$/.test(message.actionHash ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce ?? "") ||
      BigInt(message.validAfter ?? "0") >= now || BigInt(message.validBefore ?? "0") <= now ||
      BigInt(message.validBefore ?? "0") > now + 86400n || value.review.rawValue !== "0" || value.review.amount !== "0" ||
      value.review.expiresAt !== new Date(Number(message.validBefore) * 1000).toISOString()) throw new Error("Invalid action authorization request.");
    return value;
  }
  if (value.primaryType !== "ReceiveWithAuthorization" || JSON.stringify(value.types) !== JSON.stringify({ReceiveWithAuthorization: receiveFields}) ||
    value.domain.chainId !== 10143 || !/^0x[0-9a-fA-F]{40}$/.test(value.domain.verifyingContract) ||
    getAddress(message.from ?? "") !== getAddress(account) || getAddress(message.to ?? "") !== getAddress(value.review.recipient) ||
    !/^(0|[1-9][0-9]*)$/.test(message.value ?? "") || BigInt(message.value!) === 0n ||
    !/^0x[0-9a-fA-F]{64}$/.test(message.nonce ?? "") ||
    BigInt(message.validAfter ?? "0") >= now || BigInt(message.validBefore ?? "0") <= now ||
    BigInt(message.validBefore ?? "0") > now + 86400n ||
    message.value !== value.review.rawValue ||
    value.review.amount !== formatUnits(message.value!, value.review.decimals) ||
    value.review.expiresAt !== new Date(Number(message.validBefore) * 1000).toISOString()) throw new Error("Invalid payment authorization request.");
  return value;
}

export const receiveAuthorizationFields = receiveFields;
