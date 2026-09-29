// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library PayUnlockTransfers {
    using SafeERC20 for IERC20;
    error TransferFailed();
    error InexactTransfer();


    function collect(address asset, address payer, uint256 amount) public {
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(payer, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert InexactTransfer();
    }
    function pay(address asset, address recipient, uint256 amount) public {
        if (asset == address(0)) {
            (bool ok,) = payable(recipient).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20 token = IERC20(asset);
            uint256 beforeEscrow = token.balanceOf(address(this));
            uint256 beforeRecipient = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            if (token.balanceOf(address(this)) != beforeEscrow - amount || token.balanceOf(recipient) != beforeRecipient + amount) revert InexactTransfer();
        }
    }
}
