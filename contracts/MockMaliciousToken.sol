// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IDAXAgreement {
    function submitAndRelease(bytes32 agreementId, bytes32 evidenceHash, uint256 deadline, bytes calldata buyerSignature) external;
    function mutualCancel(bytes32 agreementId, uint256 deadline, bytes calldata sigA, bytes calldata sigB) external;
}

/**
 * @title MockMaliciousToken
 * @notice Test token that attempts reentrancy during transfer and simulates fee-on-transfer behavior.
 */
contract MockMaliciousToken is IERC20 {
    string public name = "Malicious Token";
    string public symbol = "MAL";
    uint8 public decimals = 18;
    uint256 public override totalSupply;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    address public targetAgreementContract;
    bytes32 public attackAgreementId;
    bool public attemptReentrancy;
    bool public isFeeOnTransfer;

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
    }

    function setAttackTarget(address target, bytes32 agreementId) external {
        targetAgreementContract = target;
        attackAgreementId = agreementId;
        attemptReentrancy = true;
    }

    function setFeeOnTransfer(bool enable) external {
        isFeeOnTransfer = enable;
    }

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MAL: Insufficient balance");
        balanceOf[msg.sender] -= amount;

        uint256 transferAmount = amount;
        if (isFeeOnTransfer) {
            transferAmount = amount / 2; // Takes 50% fee
        }

        balanceOf[recipient] += transferAmount;
        emit Transfer(msg.sender, recipient, transferAmount);

        // Attempt malicious reentrancy during transfer hook
        if (attemptReentrancy && targetAgreementContract != address(0)) {
            attemptReentrancy = false; // Prevent infinite loop
            bytes memory dummySig = new bytes(65);
            // Reentrancy attempt into submitAndRelease
            try IDAXAgreement(targetAgreementContract).submitAndRelease(attackAgreementId, bytes32(0), block.timestamp + 3600, dummySig) {
                // Success (should not happen)
            } catch {
                // Caught reentrancy revert
            }
        }

        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external override returns (bool) {
        require(balanceOf[sender] >= amount, "MAL: Insufficient balance");
        require(allowance[sender][msg.sender] >= amount, "MAL: Insufficient allowance");

        balanceOf[sender] -= amount;
        allowance[sender][msg.sender] -= amount;

        uint256 transferAmount = amount;
        if (isFeeOnTransfer) {
            transferAmount = amount / 2; // Deliberately delivers 50% less
        }

        balanceOf[recipient] += transferAmount;
        emit Transfer(sender, recipient, transferAmount);
        return true;
    }
}
