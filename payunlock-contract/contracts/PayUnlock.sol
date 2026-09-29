// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayUnlockTypes as T} from "./PayUnlockTypes.sol";
import {PayUnlockCodec as Codec} from "./PayUnlockCodec.sol";
import {PayUnlockArbitration as Arbitration} from "./PayUnlockArbitration.sol";
import {PayUnlockTransfers as Transfers} from "./PayUnlockTransfers.sol";

/// @notice Immutable escrow. Administrator cannot sweep funds or change participants.
contract PayUnlock is Ownable2Step, ReentrancyGuard {
    uint256 public constant RETENTION = 365 days;
    bytes32 public constant STORAGE_POLICY = keccak256("payunlock-storage-v1:31536000:preparation:no-managers");
    uint256 public constant MAX_BATCH = 30;
    uint256 public batchLimit = 30;
    mapping(uint32 => bool) public allowedStorageServices;
    uint64 public minResponseWindow;
    uint32 public minCommitmentWindow;
    uint32 public maxCommitmentWindow;
    uint64 public defaultReviewWindow;
    uint64 public responseWindow = 3 days;
    uint256 public nextOrderId = 1;
    mapping(address => bool) public allowedAssets;
    mapping(address => bool) public receiveAuthorizationAssets;
    address public authorizationRouter;
    address private relayActor;
    mapping(address => uint256) public liabilities;
    uint16 public serviceFeeBps;
    address public feeTreasury;
    uint256 public offerPlacementFee;
    uint64 public placementFeeVersion;
    mapping(address => mapping(bytes32 => uint16)) public sellerFeeCapBps;
    struct FeeSnapshot { uint16 bps; address treasury; uint256 amount; }
    mapping(uint256 => FeeSnapshot) public orderFees;
    mapping(address => mapping(address => uint256)) public accruedFees;
    mapping(address => mapping(bytes32 => uint256)) public orderForRequest;
    mapping(address => mapping(bytes32 => T.Product)) private products;
    mapping(uint256 => T.Order) private orders;
    mapping(uint256 => mapping(uint256 => T.Reference)) private records;
    mapping(uint256 => mapping(uint256 => bytes32)) public recordCommitments;
    mapping(uint256 => mapping(uint256 => address)) public recordAuthors;
    address public arbitrationFeeAsset;

    error InvalidInput();
    error NotFound();
    error Unauthorized();
    error InvalidState();
    error Deadline();
    error StaleTerms();
    error DuplicateRequest();
    error TransferFailed();
    error InexactTransfer();
    event AssetAllowed(address indexed asset, bool allowed);
    event ReceiveAuthorizationAssetConfigured(address indexed asset, bool enabled);
    event AuthorizationRouterSet(address indexed router);
    event ServiceFeeConfigured(uint16 bps, address indexed treasury);
    event PlacementFeeConfigured(uint256 amount, uint64 version);
    event SellerFeeCapConfigured(address indexed seller, bytes32 indexed key, uint16 bps);
    event FeeAccrued(uint256 indexed orderId, address indexed treasury, address indexed asset, uint256 amount);
    event FeesClaimed(address indexed treasury, address indexed asset, uint256 amount);
    event StorageServiceAdded(uint32 indexed serviceId);
    event BatchLimitChanged(uint256 batchLimit);
    event TimingBoundsChanged(uint64 minResponseWindow, uint32 minCommitmentWindow, uint32 maxCommitmentWindow);
    event DefaultsChanged(uint64 reviewWindow, uint64 responseWindow);
    event ProductConfigured(address indexed seller, bytes32 indexed key, T.Product product);
    event Purchased(uint256 indexed orderId, address indexed buyer, bytes32 indexed requestId, T.Order order);
    event DeliveryReserved(uint256 indexed orderId, uint64 publicationDeadline);
    event RecordPublished(uint256 indexed orderId, uint256 indexed sequence, address indexed author, bytes32 recordHash, T.Reference contentRef);
    event StateChanged(uint256 indexed orderId, T.State state, uint64 deadline);
    event Settled(uint256 indexed orderId, address indexed recipient, address indexed asset, uint256 amount, T.State state);
    event ArbitratorConfigured(address indexed arbitrator, T.Arbitrator configuration);
    event ArbitrationFeeSet(address indexed arbitrator, uint256 fee, uint64 version);
    event ArbitrationFeeAssetSet(address indexed asset);
    event ArbitrationAssigned(uint256 indexed orderId, T.Assignment assignment, bytes32 reason);
    event EvidencePublished(uint256 indexed orderId, uint256 indexed index, address indexed submitter, uint64 revision, bytes32 recordHash, T.Evidence evidence);
    event EvidenceRequested(uint256 indexed orderId, uint256 indexed requestIndex, uint64 revision, address participant, uint64 advisoryDate, bytes32 recordHash, T.Assignment assignment, T.Evidence request);

    constructor(address admin, uint64 initialReviewWindow, uint64 responseFloor, uint32 commitmentFloor, uint32 commitmentCeiling) Ownable(admin) {
        if (responseFloor == 0 || responseFloor > responseWindow || commitmentFloor == 0 || commitmentCeiling < commitmentFloor || commitmentCeiling >= RETENTION) revert InvalidInput();
        minResponseWindow = responseFloor;
        minCommitmentWindow = commitmentFloor;
        maxCommitmentWindow = commitmentCeiling;
        defaultReviewWindow = initialReviewWindow;
        _deadline(block.timestamp, initialReviewWindow);
        allowedAssets[address(0)] = true;
        feeTreasury = admin;
        emit AssetAllowed(address(0), true);
        allowedStorageServices[1] = true;
        emit StorageServiceAdded(1);
        emit BatchLimitChanged(batchLimit);
        emit TimingBoundsChanged(responseFloor, commitmentFloor, commitmentCeiling);
        emit DefaultsChanged(defaultReviewWindow, responseWindow);
    }
    // Avoid leaving outstanding cases without a replacement authority.
    function renounceOwnership() public view override onlyOwner { revert InvalidState(); }
    function setAllowedAsset(address asset, bool allowed) external onlyOwner nonReentrant {
        if (asset != address(0) && asset.code.length == 0) revert InvalidInput();
        allowedAssets[asset] = allowed;
        emit AssetAllowed(asset, allowed);
    }
    function setReceiveAuthorizationAsset(address asset, bool enabled) external onlyOwner {
        if (asset == address(0) || asset.code.length == 0 || !allowedAssets[asset]) revert InvalidInput();
        receiveAuthorizationAssets[asset] = enabled;
        emit ReceiveAuthorizationAssetConfigured(asset, enabled);
    }
    function setAuthorizationRouter(address router) external onlyOwner {
        if (authorizationRouter != address(0) || router.code.length == 0) revert InvalidInput();
        authorizationRouter = router;
        emit AuthorizationRouterSet(router);
    }
    function _actor() private view returns (address) { return relayActor == address(0) ? msg.sender : relayActor; }
    /// @notice Called only by the immutable router after it verifies an exact
    /// signed action. The router's explicit allowlist excludes payable/admin calls.
    function executeFromRouter(address actor, bytes calldata actionData) external returns (bytes memory result) {
        if (msg.sender != authorizationRouter || authorizationRouter == address(0) || relayActor != address(0) || actor == address(0)) revert Unauthorized();
        relayActor = actor;
        (bool ok, bytes memory output) = address(this).delegatecall(actionData);
        relayActor = address(0);
        if (!ok) assembly { revert(add(output, 32), mload(output)) }
        return output;
    }
    function setServiceFee(uint16 bps, address treasury) external onlyOwner {
        if (bps > 10_000 || treasury == address(0) || treasury == address(this)) revert InvalidInput();
        serviceFeeBps = bps;
        feeTreasury = treasury;
        emit ServiceFeeConfigured(bps, treasury);
    }
    function setOfferPlacementFee(uint256 amount) external onlyOwner {
        offerPlacementFee = amount;
        ++placementFeeVersion;
        emit PlacementFeeConfigured(amount, placementFeeVersion);
    }
    function setArbitrationFeeAsset(address asset) external onlyOwner {
        if (asset == address(0) || !allowedAssets[asset]) revert InvalidInput();
        arbitrationFeeAsset = asset;
        emit ArbitrationFeeAssetSet(asset);
    }
    function claimFees(address asset) external nonReentrant {
        address recipient = _actor();
        uint256 amount = accruedFees[recipient][asset];
        if (amount == 0) revert InvalidState();
        accruedFees[recipient][asset] = 0;
        _pay(asset, recipient, amount);
        emit FeesClaimed(recipient, asset, amount);
    }
    /// @notice IDs are permanent protocol assignments; origins/adapters are configured offchain.
    function addStorageService(uint32 serviceId) external onlyOwner nonReentrant {
        if (serviceId == 0 || allowedStorageServices[serviceId]) revert InvalidInput();
        allowedStorageServices[serviceId] = true;
        emit StorageServiceAdded(serviceId);
    }
    function setBatchLimit(uint256 value) external onlyOwner nonReentrant {
        if (value == 0 || value > MAX_BATCH) revert InvalidInput();
        batchLimit = value;
        emit BatchLimitChanged(value);
    }
    function setTimingBounds(uint64 responseFloor, uint32 commitmentFloor, uint32 commitmentCeiling) external onlyOwner nonReentrant {
        if (responseFloor == 0 || responseFloor > responseWindow || commitmentFloor == 0 || commitmentCeiling < commitmentFloor || commitmentCeiling >= RETENTION) revert InvalidInput();
        minResponseWindow = responseFloor;
        minCommitmentWindow = commitmentFloor;
        maxCommitmentWindow = commitmentCeiling;
        emit TimingBoundsChanged(responseFloor, commitmentFloor, commitmentCeiling);
    }
    function _service(T.Reference calldata contentRef) private view {
        if (!allowedStorageServices[contentRef.serviceId]) revert InvalidInput();
    }
    function setDefaultReviewWindow(uint64 value) external onlyOwner nonReentrant {
        _deadline(block.timestamp, value);
        defaultReviewWindow = value;
        emit DefaultsChanged(defaultReviewWindow, responseWindow);
    }
    function setResponseWindow(uint64 value) external onlyOwner nonReentrant {
        if (value < minResponseWindow) revert InvalidInput();
        _deadline(block.timestamp, value);
        responseWindow = value;
        emit DefaultsChanged(defaultReviewWindow, responseWindow);
    }
    function _receiving(T.Receiving memory r) private pure {
        if (r.nonce == 0 || r.publicKey == 0) revert InvalidInput();
    }
    function _terms(T.ProductTerms memory t) private view {
        if (!allowedAssets[t.token] || t.price == 0 || (!t.hasEventEnd && t.eventEnd != 0) ||
            (!t.hasReviewOverride && t.reviewOverride != 0) || t.commitmentWindow < minCommitmentWindow || t.commitmentWindow > maxCommitmentWindow) revert InvalidInput();
        uint256 base = t.hasEventEnd && t.eventEnd > block.timestamp ? t.eventEnd : block.timestamp;
        _deadline(base, t.hasReviewOverride ? t.reviewOverride : defaultReviewWindow);
    }
    function createProduct(bytes32 key, T.ProductTerms calldata terms, T.Receiving calldata receiving, uint16 feeCapBps, uint256 expectedPlacementFee, uint64 expectedFeeVersion) external payable nonReentrant {
        _createProduct(key, terms, receiving, feeCapBps, expectedPlacementFee, expectedFeeVersion);
    }
    function _createProduct(bytes32 key, T.ProductTerms calldata terms, T.Receiving calldata receiving, uint16 feeCapBps, uint256 expectedPlacementFee, uint64 expectedFeeVersion) private {
        if (key == 0 || products[msg.sender][key].status != T.ProductStatus.Nonexistent || feeCapBps > 10_000) revert InvalidInput();
        if (expectedPlacementFee != offerPlacementFee || expectedFeeVersion != placementFeeVersion) revert StaleTerms();
        if (msg.value != expectedPlacementFee) revert InexactTransfer();
        _terms(terms); _receiving(receiving);
        products[msg.sender][key] = T.Product(T.ProductStatus.Active, terms, receiving, 0);
        sellerFeeCapBps[msg.sender][key] = feeCapBps;
        if (expectedPlacementFee != 0) accruedFees[feeTreasury][address(0)] += expectedPlacementFee;
        emit SellerFeeCapConfigured(msg.sender, key, feeCapBps);
        emit ProductConfigured(msg.sender, key, products[msg.sender][key]);
    }
    function setSellerFeeCap(bytes32 key, uint16 capBps) external {
        _product(_actor(), key);
        if (capBps > 10_000) revert InvalidInput();
        sellerFeeCapBps[_actor()][key] = capBps;
        emit SellerFeeCapConfigured(_actor(), key, capBps);
    }
    function updateProduct(bytes32 key, T.ProductTerms calldata terms, T.Receiving calldata receiving) external nonReentrant {
        T.Product storage p = _product(_actor(), key);
        if (p.status == T.ProductStatus.Canceled || (p.orderCount != 0 && p.terms.token != terms.token)) revert InvalidState();
        _terms(terms); _receiving(receiving);
        p.terms = terms; p.receiving = receiving;
        emit ProductConfigured(_actor(), key, p);
    }
    function setSalesDisabled(bytes32 key, bool disabled) external nonReentrant {
        T.Product storage p = _product(_actor(), key);
        if (p.status == T.ProductStatus.Canceled) revert InvalidState();
        p.status = disabled ? T.ProductStatus.Disabled : T.ProductStatus.Active;
        emit ProductConfigured(_actor(), key, p);
    }
    function cancelProduct(bytes32 key) external nonReentrant {
        T.Product storage p = _product(_actor(), key);
        if (p.status == T.ProductStatus.Canceled) revert InvalidState();
        p.status = T.ProductStatus.Canceled;
        emit ProductConfigured(_actor(), key, p);
    }
    function getProduct(address seller, bytes32 key) external view returns (T.Product memory) { return _product(seller, key); }
    function _product(address seller, bytes32 key) private view returns (T.Product storage p) {
        p = products[seller][key];
        if (p.status == T.ProductStatus.Nonexistent) revert NotFound();
    }
    function currentTerms(address seller, bytes32 key) public view returns (T.Terms memory t) {
        T.Product storage p = _product(seller, key);
        t = T.Terms(p.terms.token, p.terms.price, p.terms.hasEventEnd, p.terms.eventEnd,
            p.terms.hasReviewOverride ? p.terms.reviewOverride : defaultReviewWindow, responseWindow, p.terms.commitmentWindow);
    }
    function checkoutHash(address seller, bytes32 key) public view returns (bytes32) {
        return keccak256(abi.encode("payunlock-checkout-v2", block.chainid, address(this), seller, key, currentTerms(seller, key), products[seller][key].receiving, STORAGE_POLICY, serviceFeeBps, feeTreasury, sellerFeeCapBps[seller][key]));
    }
    function purchase(address seller, bytes32 key, bytes32 requestId, bytes32 expectedTerms, T.Receiving calldata buyerReceiving) external payable nonReentrant returns (uint256 id) {
        return _purchase(msg.sender, msg.sender, seller, key, requestId, expectedTerms, buyerReceiving);
    }
    function purchaseFromRouter(address buyer, address seller, bytes32 key, bytes32 requestId, bytes32 expectedTerms, T.Receiving calldata buyerReceiving) external nonReentrant returns (uint256 id) {
        if (msg.sender != authorizationRouter || authorizationRouter == address(0)) revert Unauthorized();
        return _purchase(buyer, msg.sender, seller, key, requestId, expectedTerms, buyerReceiving);
    }
    function _purchase(address buyer, address payer, address seller, bytes32 key, bytes32 requestId, bytes32 expectedTerms, T.Receiving calldata buyerReceiving) private returns (uint256 id) {
        if (requestId == 0 || seller == buyer) revert InvalidInput();
        if (orderForRequest[buyer][requestId] != 0) revert DuplicateRequest();
        T.Product storage p = _product(seller, key);
        if (p.status != T.ProductStatus.Active || !allowedAssets[p.terms.token]) revert InvalidState();
        if (serviceFeeBps > sellerFeeCapBps[seller][key]) revert InvalidState();
        _terms(p.terms);
        if (checkoutHash(seller, key) != expectedTerms) revert StaleTerms();
        _receiving(buyerReceiving);
        T.Terms memory terms = currentTerms(seller, key);
        uint256 latest = block.timestamp + terms.commitmentWindow;
        if (terms.hasEventEnd && terms.eventEnd > latest) latest = terms.eventEnd;
        if (_deadline(latest, terms.reviewWindow) >= block.timestamp + RETENTION) revert InvalidInput();
        _deadline(block.timestamp, terms.responseWindow);
        id = nextOrderId++;
        orderForRequest[buyer][requestId] = id;
        T.Order storage o = orders[id];
        o.state = T.State.Paid; o.buyer = buyer; o.seller = seller; o.productKey = key; o.requestId = requestId;
        o.buyerReceiving = buyerReceiving; o.sellerReceiving = p.receiving; o.terms = terms;
        // Quotient/remainder avoids price * bps overflow and rounds down.
        uint256 fee = (terms.price / 10_000) * serviceFeeBps + ((terms.price % 10_000) * serviceFeeBps) / 10_000;
        orderFees[id] = FeeSnapshot(serviceFeeBps, feeTreasury, fee);
        ++p.orderCount;
        liabilities[terms.token] += terms.price;
        if (terms.token == address(0)) {
            if (payer != buyer) revert InvalidState();
            if (msg.value != terms.price) revert InexactTransfer();
        } else {
            if (msg.value != 0) revert InexactTransfer();
            if (payer != buyer && !receiveAuthorizationAssets[terms.token]) revert InvalidState();
            Transfers.collect(terms.token, payer, terms.price);
        }
        emit Purchased(id, buyer, requestId, o);
    }
    function getOrder(uint256 id) external view returns (T.Order memory) { return _order(id); }
    function _order(uint256 id) private view returns (T.Order storage o) {
        o = orders[id]; if (o.state == T.State.Nonexistent) revert NotFound();
    }
    function _canceled(T.Order storage o) private view returns (bool) { return products[o.seller][o.productKey].status == T.ProductStatus.Canceled; }
    function _deadline(uint256 base, uint256 duration) private pure returns (uint64) {
        uint256 result = base + duration;
        if (result > type(uint64).max) revert InvalidInput();
        return uint64(result);
    }
    function reserveDelivery(uint256 id) external nonReentrant { _reserve(id); }
    function reserveDeliveries(uint256[] calldata ids) external nonReentrant {
        _batch(ids.length);
        for (uint256 i; i < ids.length; ++i) _reserve(ids[i]);
    }
    function _reserve(uint256 id) private {
        T.Order storage o = _order(id);
        if (_actor() != o.seller) revert Unauthorized();
        if (o.state != T.State.Paid || _canceled(o)) revert InvalidState();
        o.publicationDeadline = _deadline(block.timestamp, o.terms.commitmentWindow);
        o.state = T.State.DeliveryReserved;
        emit DeliveryReserved(id, o.publicationDeadline);
    }
    function deliveryRecordHash(uint256 id, T.Reference calldata contentRef) external view returns (bytes32) {
        _service(contentRef);
        T.Order storage o = _order(id); return Codec.recordHash(id, abi.encode(o), contentRef, o.seller, 0, false);
    }
    function publishDelivery(uint256 id, T.Reference calldata contentRef) external nonReentrant { _publish(id, contentRef); }
    function publishDeliveries(uint256[] calldata ids, T.Reference[] calldata references) external nonReentrant {
        _batch(ids.length); if (ids.length != references.length) revert InvalidInput();
        for (uint256 i; i < ids.length; ++i) _publish(ids[i], references[i]);
    }
    function _publish(uint256 id, T.Reference calldata contentRef) private {
        T.Order storage o = _order(id);
        if (_actor() != o.seller) revert Unauthorized();
        if (o.state != T.State.DeliveryReserved || _canceled(o)) revert InvalidState();
        if (block.timestamp >= o.publicationDeadline) revert Deadline();
        _service(contentRef);
        bytes32 hash = Codec.recordHash(id, abi.encode(o), contentRef, o.seller, 0, false);
        o.deliveryHash = hash;
        uint256 base = o.terms.hasEventEnd && o.terms.eventEnd > block.timestamp ? o.terms.eventEnd : block.timestamp;
        o.reviewDeadline = _deadline(base, o.terms.reviewWindow);
        if (o.reviewDeadline >= uint256(contentRef.preparedAt) + RETENTION) revert InvalidInput();
        _record(id, o, contentRef, hash);
        o.state = T.State.Fulfilled;
        emit StateChanged(id, o.state, o.reviewDeadline);
    }
    function _record(uint256 id, T.Order storage o, T.Reference calldata contentRef, bytes32 hash) private {
        records[id][o.turn] = contentRef;
        recordCommitments[id][o.turn] = hash;
        recordAuthors[id][o.turn] = _actor();
        emit RecordPublished(id, o.turn, _actor(), hash, contentRef);
    }
    function getRecord(uint256 id, uint256 turn) external view returns (T.Reference memory) {
        if (recordCommitments[id][turn] == 0) revert NotFound(); return records[id][turn];
    }
    function claimRefund(uint256 id) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != o.buyer) revert Unauthorized();
        if (o.state != T.State.Paid && !(o.state == T.State.DeliveryReserved && (_canceled(o) || block.timestamp >= o.publicationDeadline))) revert InvalidState();
        _settle(id, o, false);
    }
    function refundCanceledOrders(uint256[] calldata ids) external nonReentrant {
        _batch(ids.length);
        for (uint256 i; i < ids.length; ++i) {
            T.Order storage o = _order(ids[i]);
            if (o.seller != _actor()) revert Unauthorized();
            if (!_canceled(o) || (o.state != T.State.Paid && o.state != T.State.DeliveryReserved)) revert InvalidState();
            _settle(ids[i], o, false);
        }
    }
    function _negotiating(T.Order storage o) private view returns (bool) { return o.state == T.State.AwaitingSeller || o.state == T.State.AwaitingBuyer; }
    function confirmReceipt(uint256 id) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != o.buyer) revert Unauthorized();
        if (o.state != T.State.Fulfilled && !_negotiating(o)) revert InvalidState();
        // An expired seller turn earns the buyer a refund; nobody can erase it.
        if (o.state == T.State.AwaitingSeller && block.timestamp >= o.responseDeadline) revert Deadline();
        o.state = T.State.Confirmed;
        emit StateChanged(id, o.state, 0);
    }
    function withdrawSeller(uint256 id) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != o.seller) revert Unauthorized();
        if (o.state != T.State.Confirmed && !(o.state == T.State.Fulfilled && block.timestamp >= o.reviewDeadline)) revert InvalidState();
        _settle(id, o, true);
    }
    function openDispute(uint256 id, T.Reference calldata contentRef) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != o.buyer) revert Unauthorized();
        if (o.state != T.State.Fulfilled) revert InvalidState();
        if (block.timestamp >= o.reviewDeadline) revert Deadline();
        _message(id, o, contentRef, T.State.AwaitingSeller);
    }
    function replyToDispute(uint256 id, uint256 expectedTurn, T.Reference calldata contentRef) external nonReentrant {
        T.Order storage o = _order(id);
        if (!_negotiating(o)) revert InvalidState();
        if (_actor() != (o.state == T.State.AwaitingSeller ? o.seller : o.buyer)) revert Unauthorized();
        if (block.timestamp >= o.responseDeadline) revert Deadline();
        if (expectedTurn != o.turn + 1) revert StaleTerms();
        _message(id, o, contentRef, o.state == T.State.AwaitingSeller ? T.State.AwaitingBuyer : T.State.AwaitingSeller);
    }
    function _message(uint256 id, T.Order storage o, T.Reference calldata contentRef, T.State next) private {
        ++o.turn;
        _service(contentRef);
        bytes32 hash = Codec.recordHash(id, abi.encode(o), contentRef, _actor(), o.turn, true);
        _record(id, o, contentRef, hash);
        o.state = next; o.responseDeadline = _deadline(block.timestamp, o.terms.responseWindow);
        emit StateChanged(id, next, o.responseDeadline);
    }
    function refundDisputedOrder(uint256 id) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != o.seller) revert Unauthorized();
        if (!_negotiating(o)) revert InvalidState();
        if (o.state == T.State.AwaitingBuyer && block.timestamp >= o.responseDeadline) revert Deadline();
        _settle(id, o, false);
    }
    function claimResponseTimeout(uint256 id) external nonReentrant {
        T.Order storage o = _order(id);
        if (!_negotiating(o)) revert InvalidState();
        if (block.timestamp < o.responseDeadline) revert Deadline();
        bool sellerWins = o.state == T.State.AwaitingBuyer;
        if (_actor() != (sellerWins ? o.seller : o.buyer)) revert Unauthorized();
        _settle(id, o, sellerWins);
    }
    function _settle(uint256 id, T.Order storage o, bool sellerWins) private {
        // Callers exhaustively restrict input states. Terminal state precedes transfer.
        o.state = sellerWins ? T.State.PaidOut : T.State.Refunded;
        address recipient = sellerWins ? o.seller : o.buyer;
        liabilities[o.terms.token] -= o.terms.price;
        uint256 fee = sellerWins ? orderFees[id].amount : 0;
        if (fee != 0) {
            address treasury = orderFees[id].treasury;
            accruedFees[treasury][o.terms.token] += fee;
            emit FeeAccrued(id, treasury, o.terms.token, fee);
        }
        uint256 payout = o.terms.price - fee;
        if (payout != 0) _pay(o.terms.token, recipient, payout);
        emit Settled(id, recipient, o.terms.token, payout, o.state);
    }
    function _pay(address asset, address recipient, uint256 amount) private {
        Transfers.pay(asset, recipient, amount);
    }
    function _batch(uint256 size) private view { if (size == 0 || size > batchLimit) revert InvalidInput(); }
    function getAssignment(uint256 id) external view returns (T.Assignment memory) {
        return Arbitration.assignment(id);
    }
    function arbitrators(address wallet) external view returns (bool active, bytes32 publicKey, uint64 keyVersion, uint256 fee) {
        T.Arbitrator memory a = Arbitration.arbitrator(wallet);
        return (a.active, a.publicKey, a.keyVersion, a.fee);
    }
    function arbitratorFeeVersion(address wallet) external view returns (uint64) { return Arbitration.feeVersion(wallet); }
    function arbitratorFeeConfigured(address wallet) external view returns (bool) { return Arbitration.feeConfigured(wallet); }
    function assignmentFeeAsset(uint256 id) external view returns (address) { return Arbitration.feeAsset(id); }
    function assignmentFeeVersion(uint256 id) external view returns (uint64) { return Arbitration.assignmentFeeVersion(id); }
    function evidenceCount(uint256 id) external view returns (uint256) { return Arbitration.evidenceCount(id); }
    function evidenceCommitments(uint256 id, uint256 index) external view returns (bytes32) { return Arbitration.evidenceCommitment(id, index); }
    function evidenceRequestCount(uint256 id) external view returns (uint256) { return Arbitration.requestCount(id); }
    function evidenceRequestCommitments(uint256 id, uint256 index) external view returns (bytes32) { return Arbitration.requestCommitment(id, index); }
    function configureArbitrator(address wallet, bytes32 publicKey, bool active) external onlyOwner nonReentrant {
        Arbitration.configure(wallet, publicKey, active);
    }
    function setMyArbitrationFee(uint64 expectedVersion, uint256 fee) external {
        Arbitration.setFee(_actor(), expectedVersion, fee);
    }
    function requestArbitration(uint256 id, address wallet, uint64 expectedKeyVersion, uint64 expectedFeeVersion, uint256 expectedFee, address expectedFeeAsset, T.Evidence calldata evidence) external nonReentrant {
        if (!allowedAssets[arbitrationFeeAsset] || arbitrationFeeAsset != expectedFeeAsset) revert InvalidState();
        _service(evidence.contentRef);
        Arbitration.request(id, _order(id), _actor(), msg.sender, wallet, expectedKeyVersion, expectedFeeVersion, expectedFee, evidence, arbitrationFeeAsset);
        emit StateChanged(id, T.State.InArbitration, 0);
    }
    function requestArbitrationFromRouter(uint256 id, address requester, address wallet, uint64 expectedKeyVersion, uint64 expectedFeeVersion, uint256 expectedFee, T.Evidence calldata evidence) external nonReentrant {
        if (msg.sender != authorizationRouter || authorizationRouter == address(0)) revert Unauthorized();
        if (!allowedAssets[arbitrationFeeAsset] || !receiveAuthorizationAssets[arbitrationFeeAsset]) revert InvalidState();
        _service(evidence.contentRef);
        Arbitration.request(id, _order(id), requester, msg.sender, wallet, expectedKeyVersion, expectedFeeVersion, expectedFee, evidence, arbitrationFeeAsset);
        emit StateChanged(id, T.State.InArbitration, 0);
    }
    function resolveArbitration(uint256 id, uint64 revision, bool sellerWins) external nonReentrant {
        T.Order storage o = _order(id);
        if (_actor() != Arbitration.checkCase(id, o, revision).wallet) revert Unauthorized();
        _settle(id, o, sellerWins);
    }
    function replaceArbitrator(uint256 id, uint64 revision, address replacement, uint64 expectedKeyVersion, bytes32 reason) external onlyOwner nonReentrant {
        Arbitration.replace(id, _order(id), revision, replacement, expectedKeyVersion, reason);
    }
    function requestArbitrationEvidence(uint256 id, uint64 revision, uint256 expectedIndex, address participant, uint64 advisoryDate, T.Evidence calldata request) external nonReentrant {
        _service(request.contentRef);
        Arbitration.requestEvidence(id, _order(id), revision, expectedIndex, participant, advisoryDate, request, _actor());
    }
    function submitArbitrationEvidence(uint256 id, uint64 revision, T.Evidence calldata evidence) external nonReentrant {
        _service(evidence.contentRef);
        Arbitration.submitEvidence(id, _order(id), revision, evidence, _actor());
    }
}
