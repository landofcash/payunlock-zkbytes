// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PayUnlockTypes as T} from "./PayUnlockTypes.sol";

interface IAuthorizationEscrow {
    function currentTerms(address seller, bytes32 key) external view returns (T.Terms memory);
    function checkoutHash(address seller, bytes32 key) external view returns (bytes32);
    function receiveAuthorizationAssets(address token) external view returns (bool);
    function purchaseFromRouter(address buyer, address seller, bytes32 key, bytes32 requestId, bytes32 expectedTerms, T.Receiving calldata buyerReceiving) external returns (uint256);
    function getOrder(uint256 id) external view returns (T.Order memory);
    function arbitrationFeeAsset() external view returns (address);
    function arbitrators(address wallet) external view returns (bool active, bytes32 publicKey, uint64 keyVersion, uint256 fee);
    function arbitratorFeeVersion(address wallet) external view returns (uint64);
    function requestArbitrationFromRouter(uint256 id, address requester, address wallet, uint64 expectedKeyVersion, uint64 expectedFeeVersion, uint256 expectedFee, T.Evidence calldata evidence) external;
    function executeFromRouter(address actor, bytes calldata actionData) external returns (bytes memory);
}

interface IReceiveAuthorizationToken {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
}

/// @notice Stateless, permissionless adapter. A token authorization is consumed only
/// when the matching escrow operation succeeds in the same transaction.
contract PayUnlockAuthorizationRouter is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    IAuthorizationEscrow public immutable escrow;
    bytes32 public constant PURCHASE_TYPEHASH = keccak256("PayUnlockPurchaseV1(uint256 chainId,address escrow,address router,address token,address buyer,address seller,bytes32 productKey,bytes32 requestId,bytes32 checkoutHash,bytes32 receivingNonce,bytes32 receivingPublicKey,uint256 amount,uint256 validAfter,uint256 validBefore,bytes32 salt)");
    bytes32 public constant ARBITRATION_TYPEHASH = keccak256("PayUnlockArbitrationV1(uint256 chainId,address escrow,address router,address token,address requester,uint256 orderId,address arbitrator,uint64 keyVersion,uint64 feeVersion,uint256 fee,bytes32 evidenceHash,uint256 turn,uint64 responseDeadline,uint256 validAfter,uint256 validBefore,bytes32 salt)");
    bytes32 public constant ACTION_TYPEHASH = keccak256("PayUnlockAction(address actor,address escrow,bytes32 actionHash,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    mapping(address => mapping(bytes32 => bool)) public usedActionNonces;
    event ActionExecuted(address indexed actor, bytes32 indexed nonce, bytes4 indexed selector, bytes32 actionHash);
    event ActionCanceled(address indexed actor, bytes32 indexed nonce);

    struct Authorization { address actor; uint256 validAfter; uint256 validBefore; bytes32 salt; bytes signature; }
    struct PurchaseIntent { address seller; bytes32 productKey; bytes32 requestId; bytes32 expectedCheckoutHash; T.Receiving receiving; }
    struct ArbitrationIntent { uint256 orderId; address arbitrator; uint64 keyVersion; uint64 feeVersion; uint256 fee; T.Evidence evidence; }
    struct ActionAuthorization { address actor; bytes32 nonce; uint256 validAfter; uint256 validBefore; }

    error InvalidIntent();
    error InexactTransfer();

    constructor(IAuthorizationEscrow escrow_) EIP712("PayUnlockActionRouter", "1") {
        if (address(escrow_) == address(0)) revert InvalidIntent();
        escrow = escrow_;
    }

    function actionDigest(ActionAuthorization calldata authorization, bytes calldata actionData) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH, authorization.actor, address(escrow), keccak256(actionData), authorization.nonce, authorization.validAfter, authorization.validBefore)));
    }
    function _allowed(bytes calldata actionData) private pure returns (bool) {
        if (actionData.length < 4) return false;
        bytes4 selector = bytes4(actionData[:4]);
        return selector == bytes4(keccak256("updateProduct(bytes32,(address,uint256,bool,uint64,bool,uint64,uint32),(bytes32,bytes32))")) ||
            selector == bytes4(keccak256("setSalesDisabled(bytes32,bool)")) || selector == bytes4(keccak256("cancelProduct(bytes32)")) ||
            selector == bytes4(keccak256("setSellerFeeCap(bytes32,uint16)")) || selector == bytes4(keccak256("reserveDelivery(uint256)")) ||
            selector == bytes4(keccak256("reserveDeliveries(uint256[])")) ||
            selector == bytes4(keccak256("publishDelivery(uint256,(uint32,uint64,bytes32,bytes,bytes,bytes32))")) ||
            selector == bytes4(keccak256("publishDeliveries(uint256[],(uint32,uint64,bytes32,bytes,bytes,bytes32)[])")) ||
            selector == bytes4(keccak256("claimRefund(uint256)")) || selector == bytes4(keccak256("refundCanceledOrders(uint256[])")) ||
            selector == bytes4(keccak256("claimFees(address)")) ||
            selector == bytes4(keccak256("confirmReceipt(uint256)")) || selector == bytes4(keccak256("withdrawSeller(uint256)")) ||
            selector == bytes4(keccak256("openDispute(uint256,(uint32,uint64,bytes32,bytes,bytes,bytes32))")) ||
            selector == bytes4(keccak256("replyToDispute(uint256,uint256,(uint32,uint64,bytes32,bytes,bytes,bytes32))")) ||
            selector == bytes4(keccak256("refundDisputedOrder(uint256)")) || selector == bytes4(keccak256("claimResponseTimeout(uint256)")) ||
            selector == bytes4(keccak256("submitArbitrationEvidence(uint256,uint64,((uint32,uint64,bytes32,bytes,bytes,bytes32),bytes))")) ||
            selector == bytes4(keccak256("requestArbitrationEvidence(uint256,uint64,uint256,address,uint64,((uint32,uint64,bytes32,bytes,bytes,bytes32),bytes))")) ||
            selector == bytes4(keccak256("resolveArbitration(uint256,uint64,bool)")) ||
            selector == bytes4(keccak256("setMyArbitrationFee(uint64,uint256)"));
    }
    function isAllowedAction(bytes calldata actionData) external pure returns (bool) { return _allowed(actionData); }
    function _consume(ActionAuthorization calldata authorization, bytes calldata actionData) private {
        if (authorization.actor == address(0) || authorization.nonce == 0 ||
            block.timestamp <= authorization.validAfter || block.timestamp >= authorization.validBefore ||
            authorization.validBefore > block.timestamp + 1 days || usedActionNonces[authorization.actor][authorization.nonce] || !_allowed(actionData)) revert InvalidIntent();
        usedActionNonces[authorization.actor][authorization.nonce] = true;
    }
    function executeAuthorized(ActionAuthorization calldata authorization, bytes calldata actionData, bytes calldata signature) external nonReentrant returns (bytes memory) {
        if (ECDSA.recover(actionDigest(authorization, actionData), signature) != authorization.actor) revert InvalidIntent();
        _consume(authorization, actionData);
        bytes memory result = escrow.executeFromRouter(authorization.actor, actionData);
        emit ActionExecuted(authorization.actor, authorization.nonce, bytes4(actionData[:4]), keccak256(actionData));
        return result;
    }
    function executeDirect(ActionAuthorization calldata authorization, bytes calldata actionData) external nonReentrant returns (bytes memory) {
        if (authorization.actor != msg.sender) revert InvalidIntent();
        _consume(authorization, actionData);
        bytes memory result = escrow.executeFromRouter(msg.sender, actionData);
        emit ActionExecuted(msg.sender, authorization.nonce, bytes4(actionData[:4]), keccak256(actionData));
        return result;
    }
    function cancelActionNonce(bytes32 nonce) external {
        if (nonce == 0 || usedActionNonces[msg.sender][nonce]) revert InvalidIntent();
        usedActionNonces[msg.sender][nonce] = true;
        emit ActionCanceled(msg.sender, nonce);
    }

    function purchaseNonce(PurchaseIntent calldata intent, Authorization calldata auth) public view returns (bytes32) {
        T.Terms memory terms = escrow.currentTerms(intent.seller, intent.productKey);
        return keccak256(abi.encode(PURCHASE_TYPEHASH, block.chainid, address(escrow), address(this), terms.token, auth.actor,
            intent.seller, intent.productKey, intent.requestId, intent.expectedCheckoutHash, intent.receiving.nonce,
            intent.receiving.publicKey, terms.price, auth.validAfter, auth.validBefore, auth.salt));
    }

    function purchaseWithAuthorization(PurchaseIntent calldata intent, Authorization calldata auth) external nonReentrant returns (uint256 id) {
        T.Terms memory terms = escrow.currentTerms(intent.seller, intent.productKey);
        if (auth.actor == address(0) || auth.signature.length == 0 || auth.validBefore <= auth.validAfter ||
            terms.token == address(0) || !escrow.receiveAuthorizationAssets(terms.token) ||
            escrow.checkoutHash(intent.seller, intent.productKey) != intent.expectedCheckoutHash) revert InvalidIntent();
        IERC20 token = IERC20(terms.token);
        uint256 beforeBalance = token.balanceOf(address(this));
        IReceiveAuthorizationToken(terms.token).receiveWithAuthorization(auth.actor, address(this), terms.price,
            auth.validAfter, auth.validBefore, purchaseNonce(intent, auth), auth.signature);
        if (token.balanceOf(address(this)) != beforeBalance + terms.price) revert InexactTransfer();
        token.forceApprove(address(escrow), terms.price);
        id = escrow.purchaseFromRouter(auth.actor, intent.seller, intent.productKey, intent.requestId, intent.expectedCheckoutHash, intent.receiving);
        if (token.balanceOf(address(this)) != beforeBalance) revert InexactTransfer();
        token.forceApprove(address(escrow), 0);
    }

    function arbitrationNonce(ArbitrationIntent calldata intent, Authorization calldata auth) public view returns (bytes32) {
        T.Order memory order = escrow.getOrder(intent.orderId);
        return keccak256(abi.encode(ARBITRATION_TYPEHASH, block.chainid, address(escrow), address(this), escrow.arbitrationFeeAsset(),
            auth.actor, intent.orderId, intent.arbitrator, intent.keyVersion, intent.feeVersion, intent.fee,
            keccak256(abi.encode(intent.evidence)), order.turn, order.responseDeadline, auth.validAfter, auth.validBefore, auth.salt));
    }

    function requestArbitrationWithAuthorization(ArbitrationIntent calldata intent, Authorization calldata auth) external nonReentrant {
        address asset = escrow.arbitrationFeeAsset();
        (bool active,,uint64 keyVersion,uint256 fee) = escrow.arbitrators(intent.arbitrator);
        if (auth.actor == address(0) || auth.signature.length == 0 || auth.validBefore <= auth.validAfter ||
            asset == address(0) || !escrow.receiveAuthorizationAssets(asset) || !active || fee == 0 ||
            keyVersion != intent.keyVersion || fee != intent.fee || escrow.arbitratorFeeVersion(intent.arbitrator) != intent.feeVersion) revert InvalidIntent();
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        IReceiveAuthorizationToken(asset).receiveWithAuthorization(auth.actor, address(this), fee,
            auth.validAfter, auth.validBefore, arbitrationNonce(intent, auth), auth.signature);
        if (token.balanceOf(address(this)) != beforeBalance + fee) revert InexactTransfer();
        token.forceApprove(address(escrow), fee);
        escrow.requestArbitrationFromRouter(intent.orderId, auth.actor, intent.arbitrator, intent.keyVersion,
            intent.feeVersion, intent.fee, intent.evidence);
        if (token.balanceOf(address(this)) != beforeBalance) revert InexactTransfer();
        token.forceApprove(address(escrow), 0);
    }
}
