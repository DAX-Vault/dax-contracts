// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ReentrancyGuardUpgradeable
 * @dev Upgradeable-safe reentrancy protection using ERC-7201 namespaced storage layout.
 * Prevents storage collisions across contract upgrades and avoids constructor warnings.
 */
abstract contract ReentrancyGuardUpgradeable is Initializable {
    /// @custom:storage-location erc7201:dax.storage.ReentrancyGuard
    struct ReentrancyGuardStorage {
        uint256 _status;
    }

    // keccak256(abi.encode(uint256(keccak256("dax.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REENTRANCY_GUARD_STORAGE =
        0x952026121aacc115205cdcf5ea8c8773cf4793b056d2e75a711b201a4087dd00;

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    error ReentrancyGuardReentrantCall();

    function __ReentrancyGuard_init() internal onlyInitializing {
        __ReentrancyGuard_init_unchained();
    }

    function __ReentrancyGuard_init_unchained() internal onlyInitializing {
        _getReentrancyGuardStorage()._status = NOT_ENTERED;
    }

    function _getReentrancyGuardStorage() private pure returns (ReentrancyGuardStorage storage $) {
        bytes32 slot = REENTRANCY_GUARD_STORAGE;
        assembly {
            $.slot := slot
        }
    }

    modifier nonReentrant() {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        if ($._status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }
        $._status = ENTERED;
        _;
        $._status = NOT_ENTERED;
    }
}
