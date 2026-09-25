// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title DAX_Token
 * @notice Canonical ERC-20 utility and security staking token for the DAX Protocol.
 * @dev Enforces an immutable total supply cap of exactly 2,000,000,000 DAX.
 *      Supports EIP-2612 permit for gasless approvals.
 *      Supports ERC20Burnable for deflationary juror slashing and fee burns.
 *      No mint function exists post-deployment, ensuring supply cannot be inflated.
 */
contract DAX_Token is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY_CAP = 2_000_000_000 * 10 ** 18; // 2 Billion DAX

    /**
     * @param initialHolder The address receiving the full 2,000,000,000 DAX initial supply
     *                      (typically the deployed ledger / treasury or initial liquidity gate).
     */
    constructor(address initialHolder)
        ERC20("DAX Token", "DAX")
        ERC20Permit("DAX Token")
    {
        require(initialHolder != address(0), "DAX_Token: Invalid initial holder");
        _mint(initialHolder, TOTAL_SUPPLY_CAP);
    }
}
