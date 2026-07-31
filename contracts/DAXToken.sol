// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title DAXToken
 * @notice Production-grade ERC20 token for the DAX ecosystem.
 * Features a fixed maximum supply of 10,000,000 DAX minted to the deployer.
 * No minting capability exists after deployment, guaranteeing supply scarcity.
 */
contract DAXToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("DAX Platform Token", "DAX") {
        _mint(msg.sender, initialSupply);
    }
}
