// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Phase 1 deployment/tooling probe. This is not the PayUnlock escrow.
contract FoundationProbe {
    uint256 public immutable schemaVersion;
    constructor(uint256 initialVersion) {
        require(initialVersion > 0, "version required");
        schemaVersion = initialVersion;
    }
}
