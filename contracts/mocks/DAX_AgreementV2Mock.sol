// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/DAX_AgreementUpgradeable.sol";

/**
 * @title DAX_AgreementV2Mock
 * @notice Mock implementation of V2 to demonstrate seamless UUPS upgrade without storage loss.
 */
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract DAX_AgreementV2Mock is DAX_AgreementUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address trustedForwarder_) DAX_AgreementUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    function initializeV2() external reinitializer(2) {}

    function protocolVersion() external pure returns (string memory) {
        return "2.0.0-UUPS";
    }
}
