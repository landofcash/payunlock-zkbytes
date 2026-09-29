import { AbiCoder, formatUnits, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import type { ReviewedTypedData } from "@/wallet/types";
import { receiveAuthorizationFields } from "@/wallet/typed-data";
import type { Asset, Configuration, Deployment, Receiving } from "./client";

const PURCHASE_TYPEHASH = keccak256(toUtf8Bytes("PayUnlockPurchaseV1(uint256 chainId,address escrow,address router,address token,address buyer,address seller,bytes32 productKey,bytes32 requestId,bytes32 checkoutHash,bytes32 receivingNonce,bytes32 receivingPublicKey,uint256 amount,uint256 validAfter,uint256 validBefore,bytes32 salt)"));
const ARBITRATION_TYPEHASH = keccak256(toUtf8Bytes("PayUnlockArbitrationV1(uint256 chainId,address escrow,address router,address token,address requester,uint256 orderId,address arbitrator,uint64 keyVersion,uint64 feeVersion,uint256 fee,bytes32 evidenceHash,uint256 turn,uint64 responseDeadline,uint256 validAfter,uint256 validBefore,bytes32 salt)"));
const coder = AbiCoder.defaultAbiCoder();
const randomSalt = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")}`;

export function buildPurchaseAuthorization(input: { configuration: Configuration; deployment: Deployment; asset: Asset; buyer: string; requestId: string; receiving: Receiving; title: string; now?: number; salt?: string }) {
  const { configuration: c, deployment: d, asset, buyer, requestId, receiving } = input;
  if (!d.router || !d.usdc || d.contract.toLowerCase() !== c.contract.toLowerCase() || c.authorizationMode !== "eip3009-receive" ||
      c.terms.token.toLowerCase() !== d.usdc.toLowerCase() || asset.authorizationProfile?.mode !== "eip3009-receive" ||
      asset.token.toLowerCase() !== c.terms.token.toLowerCase()) throw new Error("This token is not configured for sponsored payment.");
  const validAfter = "0", validBefore = String(Math.floor((input.now ?? Date.now()) / 1000) + 3600), salt = input.salt ?? randomSalt();
  const nonce = keccak256(coder.encode(
    ["bytes32", "uint256", "address", "address", "address", "address", "address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "bytes32"],
    [PURCHASE_TYPEHASH, d.chainId, d.contract, d.router, c.terms.token, buyer, c.seller, c.productKey, requestId, c.expectedTerms, receiving.nonce, receiving.publicKey, c.terms.price, validAfter, validBefore, salt],
  ));
  const typedData: ReviewedTypedData = {
    domain: { name: asset.authorizationProfile.name, version: asset.authorizationProfile.version, chainId: d.chainId, verifyingContract: c.terms.token as `0x${string}` },
    primaryType: "ReceiveWithAuthorization",
    types: { ReceiveWithAuthorization: receiveAuthorizationFields },
    message: { from: buyer, to: d.router, value: c.terms.price, validAfter, validBefore, nonce },
    review: { title: input.title, asset: asset.symbol, amount: formatUnits(c.terms.price, asset.decimals), rawValue: c.terms.price,
      decimals: asset.decimals, recipient: d.router, expiresAt: new Date(Number(validBefore) * 1000).toISOString() },
  };
  const intent = { seller: c.seller, productKey: c.productKey, requestId, expectedCheckoutHash: c.expectedTerms, receiving };
  const authorization = { actor: buyer, validAfter, validBefore, salt };
  return { typedData, intent, authorization, nonce };
}

export function assertPurchaseSignature(data: ReviewedTypedData, signature: string, buyer: string) {
  const recovered = verifyTypedData(data.domain, data.types, data.message, signature);
  if (recovered.toLowerCase() !== buyer.toLowerCase()) throw new Error("Wallet signed for a different account.");
}

export function buildArbitrationAuthorization(input: { deployment: Deployment; asset: Pick<Asset, "token" | "symbol" | "decimals" | "authorizationProfile">;
  requester: string; orderId: string; turn: string; responseDeadline: string; arbitrator: string; keyVersion: string; feeVersion: string; fee: string;
  evidence: { contentRef: { serviceId: number; preparedAt: string; creator: string; buyerEnvelope: string; sellerEnvelope: string; contentHash: string }; arbitratorEnvelope: string };
  now?: number; salt?: string }) {
  const { deployment: d, asset } = input;
  if (!d.router || !d.usdc || asset.token.toLowerCase() !== d.usdc.toLowerCase() || asset.authorizationProfile?.mode !== "eip3009-receive")
    throw new Error("This arbitration token is not configured for sponsored payment.");
  const validAfter = "0", validBefore = String(Math.floor((input.now ?? Date.now()) / 1000) + 3600), salt = input.salt ?? randomSalt();
  const evidenceHash = keccak256(coder.encode(
    ["tuple(tuple(uint32 serviceId,uint64 preparedAt,bytes32 creator,bytes buyerEnvelope,bytes sellerEnvelope,bytes32 contentHash) contentRef,bytes arbitratorEnvelope)"], [input.evidence],
  ));
  const nonce = keccak256(coder.encode(
    ["bytes32", "uint256", "address", "address", "address", "address", "uint256", "address", "uint64", "uint64", "uint256", "bytes32", "uint256", "uint64", "uint256", "uint256", "bytes32"],
    [ARBITRATION_TYPEHASH, d.chainId, d.contract, d.router, asset.token, input.requester, input.orderId, input.arbitrator,
      input.keyVersion, input.feeVersion, input.fee, evidenceHash, input.turn, input.responseDeadline, validAfter, validBefore, salt],
  ));
  const typedData: ReviewedTypedData = {
    domain: { name: asset.authorizationProfile.name, version: asset.authorizationProfile.version, chainId: d.chainId, verifyingContract: asset.token as `0x${string}` },
    primaryType: "ReceiveWithAuthorization", types: { ReceiveWithAuthorization: receiveAuthorizationFields },
    message: { from: input.requester, to: d.router, value: input.fee, validAfter, validBefore, nonce },
    review: { title: `Arbitration fee for order #${input.orderId}`, asset: asset.symbol, amount: formatUnits(input.fee, asset.decimals), rawValue: input.fee,
      decimals: asset.decimals, recipient: d.router, expiresAt: new Date(Number(validBefore) * 1000).toISOString() },
  };
  return { typedData, nonce, intent: { orderId: input.orderId, arbitrator: input.arbitrator, keyVersion: input.keyVersion, feeVersion: input.feeVersion,
    fee: input.fee, evidence: input.evidence }, authorization: { actor: input.requester, validAfter, validBefore, salt } };
}
