// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDAX_OfferPool {
    enum OfferState { NON_EXISTENT, OPEN, PARTIALLY_FILLED, FULFILLED, CANCELLED }

    struct Offer {
        bytes32 offerId;
        address payable creator;
        address tokenAddress;
        uint256 totalAmount;
        uint256 remainingAmount;
        uint256 minFillAmount;
        bytes32 offerTermsHash;
        uint64 durationSeconds;
        uint64 createdAt;
        uint64 expiresAt;
        OfferState state;
        bytes32 salt;
    }

    event OfferPublished(
        bytes32 indexed offerId,
        address indexed creator,
        address tokenAddress,
        uint256 totalAmount,
        uint256 minFillAmount,
        bytes32 offerTermsHash,
        uint64 durationSeconds,
        uint64 expiresAt,
        string offerUri
    );

    event OfferSliceAccepted(
        bytes32 indexed offerId,
        bytes32 indexed childAgreementId,
        address indexed partyB,
        uint256 fillAmount,
        bytes32 childTermsHash,
        uint256 remainingAmount
    );

    event OfferCancelled(bytes32 indexed offerId, address indexed creator, uint256 refundedAmount);
    event ExpiredFundsClaimed(bytes32 indexed offerId, address indexed creator, uint256 claimedAmount);

    function publishOffer(
        address tokenAddress,
        uint256 totalAmount,
        uint256 minFillAmount,
        bytes32 offerTermsHash,
        uint64 durationSeconds,
        uint64 offerExpirySeconds,
        bytes32 salt
    ) external returns (bytes32 offerId);

    function cancelOffer(bytes32 offerId) external;
    function claimExpiredFunds(bytes32 offerId) external;
}
