// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PayUnlockTypes as T} from "./PayUnlockTypes.sol";
import {PayUnlockCodec as Codec} from "./PayUnlockCodec.sol";

/// @notice Delegate-called arbitration logic. Storage lives in the escrow at
/// an independent namespaced slot; logs therefore retain the escrow address.
library PayUnlockArbitration {
    using SafeERC20 for IERC20;
    bytes32 private constant SLOT = keccak256("payunlock.arbitration.v5.storage");
    struct Layout {
        mapping(address => T.Arbitrator) arbitrators;
        mapping(address => uint64) feeVersions;
        mapping(address => bool) feeConfigured;
        mapping(uint256 => T.Assignment) assignments;
        mapping(uint256 => address) feeAssets;
        mapping(uint256 => uint64) assignmentFeeVersions;
        mapping(uint256 => uint256) evidenceCounts;
        mapping(uint256 => mapping(uint256 => bytes32)) evidenceCommitments;
        mapping(uint256 => uint256) requestCounts;
        mapping(uint256 => mapping(uint256 => bytes32)) requestCommitments;
    }
    error InvalidInput();
    error NotFound();
    error Unauthorized();
    error InvalidState();
    error Deadline();
    error StaleTerms();
    error InexactTransfer();
    event ArbitratorConfigured(address indexed arbitrator, T.Arbitrator configuration);
    event ArbitrationFeeSet(address indexed arbitrator, uint256 fee, uint64 version);
    event ArbitrationAssigned(uint256 indexed orderId, T.Assignment assignment, bytes32 reason);
    event EvidencePublished(uint256 indexed orderId, uint256 indexed index, address indexed submitter, uint64 revision, bytes32 recordHash, T.Evidence evidence);
    event EvidenceRequested(uint256 indexed orderId, uint256 indexed requestIndex, uint64 revision, address participant, uint64 advisoryDate, bytes32 recordHash, T.Assignment assignment, T.Evidence request);

    function layout() private pure returns (Layout storage l) { bytes32 slot = SLOT; assembly { l.slot := slot } }
    function arbitrator(address wallet) public view returns (T.Arbitrator memory) { return layout().arbitrators[wallet]; }
    function feeVersion(address wallet) public view returns (uint64) { return layout().feeVersions[wallet]; }
    function feeConfigured(address wallet) public view returns (bool) { return layout().feeConfigured[wallet]; }
    function assignment(uint256 id) public view returns (T.Assignment memory a) {
        a = layout().assignments[id]; if (a.revision == 0) revert NotFound();
    }
    function feeAsset(uint256 id) public view returns (address) { return layout().feeAssets[id]; }
    function assignmentFeeVersion(uint256 id) public view returns (uint64) { return layout().assignmentFeeVersions[id]; }
    function evidenceCount(uint256 id) public view returns (uint256) { return layout().evidenceCounts[id]; }
    function evidenceCommitment(uint256 id, uint256 index) public view returns (bytes32) { return layout().evidenceCommitments[id][index]; }
    function requestCount(uint256 id) public view returns (uint256) { return layout().requestCounts[id]; }
    function requestCommitment(uint256 id, uint256 index) public view returns (bytes32) { return layout().requestCommitments[id][index]; }

    function configure(address wallet, bytes32 publicKey, bool active) public {
        if (wallet == address(0) || wallet == address(this) || publicKey == 0) revert InvalidInput();
        T.Arbitrator storage a = layout().arbitrators[wallet];
        if (a.publicKey != publicKey) ++a.keyVersion;
        a.publicKey = publicKey; a.active = active;
        emit ArbitratorConfigured(wallet, a);
    }
    function setFee(address actor, uint64 expectedVersion, uint256 fee) public {
        Layout storage l = layout();
        T.Arbitrator storage a = l.arbitrators[actor];
        if (!a.active || expectedVersion != l.feeVersions[actor]) revert StaleTerms();
        a.fee = fee; l.feeConfigured[actor] = true;
        uint64 version = ++l.feeVersions[actor];
        emit ArbitrationFeeSet(actor, fee, version);
    }
    function _eligible(Layout storage l, address wallet, T.Order storage o) private view returns (T.Arbitrator storage a) {
        a = l.arbitrators[wallet];
        if (!a.active || wallet == o.buyer || wallet == o.seller) revert InvalidInput();
    }
    function request(uint256 id, T.Order storage o, address requester, address payer, address wallet, uint64 expectedKeyVersion, uint64 expectedFeeVersion, uint256 expectedFee, T.Evidence calldata evidence, address asset) public {
        if (requester != o.buyer && requester != o.seller) revert Unauthorized();
        if (o.state != T.State.AwaitingBuyer && o.state != T.State.AwaitingSeller) revert InvalidState();
        if (block.timestamp >= o.responseDeadline) revert Deadline();
        Layout storage l = layout();
        T.Arbitrator storage a = _eligible(l, wallet, o);
        if (a.keyVersion != expectedKeyVersion || a.fee != expectedFee || !l.feeConfigured[wallet] || l.feeVersions[wallet] != expectedFeeVersion) revert StaleTerms();
        if (asset == address(0)) revert InvalidState();
        l.assignments[id] = T.Assignment(wallet, a.publicKey, a.keyVersion, 1, a.fee, requester, false);
        l.feeAssets[id] = asset; l.assignmentFeeVersions[id] = expectedFeeVersion;
        o.state = T.State.InArbitration;
        emit ArbitrationAssigned(id, l.assignments[id], 0);
        _evidence(l, id, o, evidence, requester);
        if (a.fee != 0) {
            IERC20 token = IERC20(asset);
            uint256 beforeEscrow = token.balanceOf(address(this));
            token.safeTransferFrom(payer, address(this), a.fee);
            if (token.balanceOf(address(this)) != beforeEscrow + a.fee) revert InexactTransfer();
            uint256 beforeArbitrator = token.balanceOf(wallet);
            token.safeTransfer(wallet, a.fee);
            if (token.balanceOf(address(this)) != beforeEscrow || token.balanceOf(wallet) != beforeArbitrator + a.fee) revert InexactTransfer();
        }
    }
    function checkCase(uint256 id, T.Order storage o, uint64 revision) public view returns (T.Assignment memory a) {
        if (o.state != T.State.InArbitration) revert InvalidState();
        a = layout().assignments[id];
        if (a.revision != revision) revert StaleTerms();
    }
    function replace(uint256 id, T.Order storage o, uint64 revision, address replacement, uint64 expectedKeyVersion, bytes32 reason) public {
        checkCase(id, o, revision);
        Layout storage l = layout();
        T.Assignment storage a = l.assignments[id];
        T.Arbitrator storage next = _eligible(l, replacement, o);
        if (reason == 0 || replacement == a.wallet) revert InvalidInput();
        if (next.keyVersion != expectedKeyVersion) revert StaleTerms();
        a.wallet = replacement; a.publicKey = next.publicKey; a.keyVersion = next.keyVersion;
        ++a.revision; a.handoverRecorded = false;
        emit ArbitrationAssigned(id, a, reason);
    }
    function requestEvidence(uint256 id, T.Order storage o, uint64 revision, uint256 expectedIndex, address participant, uint64 advisoryDate, T.Evidence calldata request_, address actor) public {
        T.Assignment memory a = checkCase(id, o, revision);
        if (actor != a.wallet) revert Unauthorized();
        if (participant != o.buyer && participant != o.seller) revert InvalidInput();
        Layout storage l = layout();
        if (expectedIndex != l.requestCounts[id]) revert StaleTerms();
        bytes32 hash = Codec.requestHash(id, abi.encode(o), a, expectedIndex, participant, advisoryDate, request_);
        l.requestCommitments[id][expectedIndex] = hash;
        ++l.requestCounts[id];
        emit EvidenceRequested(id, expectedIndex, revision, participant, advisoryDate, hash, a, request_);
    }
    function submitEvidence(uint256 id, T.Order storage o, uint64 revision, T.Evidence calldata evidence, address actor) public {
        checkCase(id, o, revision);
        if (actor != o.buyer && actor != o.seller) revert Unauthorized();
        _evidence(layout(), id, o, evidence, actor);
    }
    function _evidence(Layout storage l, uint256 id, T.Order storage o, T.Evidence calldata evidence, address actor) private {
        T.Assignment storage a = l.assignments[id];
        bytes32 hash = Codec.evidenceHash(id, abi.encode(o), a, evidence);
        uint256 index = l.evidenceCounts[id]++;
        l.evidenceCommitments[id][index] = hash;
        a.handoverRecorded = true;
        emit EvidencePublished(id, index, actor, a.revision, hash, evidence);
    }
}
