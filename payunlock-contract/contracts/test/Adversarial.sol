// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract AdversarialRecipient {
    bool public reject;
    bool public reentered;
    address public callbackTarget;
    bytes public callback;
    function configure(bool reject_, address target_, bytes calldata callback_) external {
        reject = reject_; callbackTarget = target_; callback = callback_;
    }
    function execute(address target_, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory result) = target_.call{value: msg.value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
    receive() external payable {
        require(!reject, "recipient rejected");
        if (callbackTarget != address(0)) (reentered,) = callbackTarget.call(callback);
    }
}
contract InexactToken is ERC20 {
    bool public fee;
    address public callbackTarget;
    bytes private callback;
    bool public reentered;
    bool private inside;
    constructor(address holder) ERC20("Adversarial test token", "BAD") { _mint(holder, 1000000); }
    function setFee(bool enabled) external { fee = enabled; }
    function setCallback(address target_, bytes calldata data) external {
        callbackTarget = target_; callback = data;
        _mint(address(this), 10000); _approve(address(this), target_, 10000);
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (!inside && callbackTarget != address(0) && from != address(0)) {
            inside = true; (reentered,) = callbackTarget.call(callback); inside = false;
        }
        if (fee && from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0), 1);
            super._update(from, to, amount - 1);
        } else super._update(from, to, amount);
    }
}
