// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {FoundationProbe} from "./FoundationProbe.sol";

contract FoundationProbeTest {
    function testInitialVersion() public {
        FoundationProbe probe = new FoundationProbe(1);
        require(probe.schemaVersion() == 1, "wrong version");
    }
    function testRejectZeroVersion() public {
        try new FoundationProbe(0) { revert("accepted zero"); }
        catch Error(string memory reason) {
            require(keccak256(bytes(reason)) == keccak256("version required"), "wrong revert");
        }
    }
}
