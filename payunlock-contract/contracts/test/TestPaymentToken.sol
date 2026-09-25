// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local/testnet test asset, never a production stablecoin.
contract TestPaymentToken is ERC20 {
    constructor(address recipient) ERC20("PayUnlock Test USD", "TESTUSD") {
        require(block.chainid == 31337 || block.chainid == 10143, "test networks only");
        _mint(recipient, 1_000_000 * 10 ** decimals());
    }
    function decimals() public pure override returns (uint8) { return 6; }
}
