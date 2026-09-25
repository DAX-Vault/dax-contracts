// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/DAX_CourtUpgradeable.sol";

/**
 * @title DAX_CourtV2Mock
 * @notice Mock implementation of Court V2 to demonstrate seamless UUPS upgrade without storage loss.
 */
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract DAX_CourtV2Mock is DAX_CourtUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initializeV2() external reinitializer(2) {}

    function courtVersion() external pure returns (string memory) {
        return "2.0.0-UUPS";
    }
}
