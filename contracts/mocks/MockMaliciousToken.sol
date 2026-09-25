// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockMaliciousToken is ERC20 {
    bool public feeOnTransfer;
    bool public reentrantAttack;
    address public targetAgreement;

    constructor(uint256 initialSupply) ERC20("Malicious Token", "BAD") {
        _mint(msg.sender, initialSupply);
    }

    function setFeeOnTransfer(bool _enabled) external {
        feeOnTransfer = _enabled;
    }

    function setAttackTarget(address _target, bytes32 /* _agreementId */) external {
        reentrantAttack = true;
        targetAgreement = _target;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (feeOnTransfer) {
            uint256 fee = amount / 10;
            super.transferFrom(from, to, amount - fee);
            return true;
        }
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (reentrantAttack && targetAgreement != address(0)) {
            reentrantAttack = false; // prevent infinite loop
            (bool success, ) = targetAgreement.call(
                abi.encodeWithSignature("claimExpiredRefund(bytes32)", bytes32(0))
            );
            success;
        }
        return super.transfer(to, amount);
    }
}
