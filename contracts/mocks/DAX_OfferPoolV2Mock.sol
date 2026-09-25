// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/DAX_OfferPoolUpgradeable.sol";

/**
 * @title DAX_OfferPoolV2Mock
 * @notice Mock implementation of OfferPool V2 to demonstrate seamless UUPS upgrade without storage loss.
 */
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract DAX_OfferPoolV2Mock is DAX_OfferPoolUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initializeV2() external reinitializer(2) {}

    function poolVersion() external pure returns (string memory) {
        return "2.0.0-UUPS";
    }
}
