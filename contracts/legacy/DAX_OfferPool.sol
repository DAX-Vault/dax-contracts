// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IDAXAgreementTarget {
    function createAndFundAgreement(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        bytes32 scheduleHash,
        uint256 periodCount,
        uint64 durationSeconds,
        bytes32 salt
    ) external payable returns (bytes32 agreementId);
}

/**
 * @title DAX_OfferPool
 * @notice Permissionless, Non-Custodial Protocol Vault & Open Offer Marketplace.
 * @dev Holds creator-deposited offer liquidity. Strictly restricted output paths:
 *      1. DAX_Agreement.sol (upon valid slice acceptance)
 *      2. Creator (upon cancellation or pool expiry claim)
 *      Zero admin custody, zero sweep, zero privilege escalation paths.
 */
contract DAX_OfferPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum OfferState { NON_EXISTENT, OPEN, PARTIALLY_FILLED, FULFILLED, CANCELLED }

    struct Offer {
        bytes32 offerId;
        address payable creator;      // Party A
        address tokenAddress;         // USDT / USDC / ERC-20
        uint256 totalAmount;          // Original deposited amount
        uint256 remainingAmount;      // Available pool balance remaining
        uint256 minFillAmount;        // Minimum slice size
        bytes32 offerTermsHash;       // Parent offer terms hash
        uint64 durationSeconds;       // Child escrow duration
        uint64 expiresAt;             // Offer pool expiry timestamp
        OfferState state;
    }

    address public immutable agreementContract;

    mapping(bytes32 => Offer) public offers;
    mapping(bytes32 => string) public offerUris;
    mapping(bytes32 => bytes32[]) public childAgreements;
    uint256 public totalOffersCount;

    // Events
    event OfferPublished(
        bytes32 indexed offerId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 totalAmount,
        uint256 minFillAmount,
        bytes32 offerTermsHash,
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

    constructor(address _agreementContract) {
        require(_agreementContract != address(0), "DAX_OfferPool: Invalid agreement contract");
        agreementContract = _agreementContract;
    }

    /**
     * @notice Deposit liquidity into non-custodial offer pool vault (Backwards-compatible 7-arg signature).
     */
    function publishOffer(
        address tokenAddress,
        uint256 totalAmount,
        uint256 minFillAmount,
        bytes32 offerTermsHash,
        uint64 durationSeconds,
        uint64 offerExpirySeconds,
        bytes32 salt
    ) external returns (bytes32 offerId) {
        return publishOfferWithMetadata(
            tokenAddress,
            totalAmount,
            minFillAmount,
            offerTermsHash,
            durationSeconds,
            offerExpirySeconds,
            salt,
            ""
        );
    }

    /**
     * @notice Deposit liquidity into non-custodial offer pool vault with on-chain metadata URI.
     * Enforces fee-on-transfer protection via actual balance delta measurement.
     */
    function publishOfferWithMetadata(
        address tokenAddress,
        uint256 totalAmount,
        uint256 minFillAmount,
        bytes32 offerTermsHash,
        uint64 durationSeconds,
        uint64 offerExpirySeconds,
        bytes32 salt,
        string memory offerUri
    ) public nonReentrant returns (bytes32 offerId) {
        require(tokenAddress != address(0), "DAX_OfferPool: Invalid token");
        require(totalAmount > 0, "DAX_OfferPool: Total amount must be > 0");
        require(minFillAmount > 0 && minFillAmount <= totalAmount, "DAX_OfferPool: Invalid minFillAmount");
        require(offerTermsHash != bytes32(0), "DAX_OfferPool: Invalid terms hash");
        require(durationSeconds >= 300, "DAX_OfferPool: Duration must be >= 5 mins");
        require(offerExpirySeconds >= 600, "DAX_OfferPool: Expiry must be >= 10 mins");

        offerId = keccak256(abi.encodePacked(msg.sender, tokenAddress, totalAmount, offerTermsHash, salt, block.chainid));
        require(offers[offerId].state == OfferState.NON_EXISTENT, "DAX_OfferPool: Offer ID collision");

        // Measure actual received balance delta for fee-on-transfer token protection
        uint256 balBefore = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), totalAmount);
        uint256 balAfter = IERC20(tokenAddress).balanceOf(address(this));
        uint256 actualAmount = balAfter - balBefore;
        require(actualAmount > 0, "DAX_OfferPool: Zero tokens transferred");
        require(actualAmount >= minFillAmount, "DAX_OfferPool: Actual received below minFillAmount");

        uint64 expiresAt = uint64(block.timestamp + offerExpirySeconds);

        offers[offerId] = Offer({
            offerId: offerId,
            creator: payable(msg.sender),
            tokenAddress: tokenAddress,
            totalAmount: actualAmount,
            remainingAmount: actualAmount,
            minFillAmount: minFillAmount,
            offerTermsHash: offerTermsHash,
            durationSeconds: durationSeconds,
            expiresAt: expiresAt,
            state: OfferState.OPEN
        });

        if (bytes(offerUri).length > 0) {
            offerUris[offerId] = offerUri;
        }

        totalOffersCount++;

        emit OfferPublished(
            offerId,
            msg.sender,
            tokenAddress,
            actualAmount,
            minFillAmount,
            offerTermsHash,
            expiresAt,
            offerUri
        );
    }

    /**
     * @notice Accept a slice of an open offer pool.
     * Transfers `fillAmount` from vault into DAX_Agreement, spawning a child escrow position.
     */
    function acceptOfferSlice(
        bytes32 offerId,
        uint256 fillAmount,
        bytes32 sliceSalt
    ) external nonReentrant returns (bytes32 childAgreementId) {
        Offer storage offer = offers[offerId];
        require(offer.state == OfferState.OPEN || offer.state == OfferState.PARTIALLY_FILLED, "DAX_OfferPool: Offer not active");
        require(block.timestamp < offer.expiresAt, "DAX_OfferPool: Offer expired");
        require(msg.sender != offer.creator, "DAX_OfferPool: Creator cannot accept own offer");
        require(fillAmount >= offer.minFillAmount, "DAX_OfferPool: Fill amount below minimum");
        require(fillAmount <= offer.remainingAmount, "DAX_OfferPool: Fill amount exceeds remaining");

        // Dust prevention invariant: remaining cannot drop below minFillAmount unless it reaches exactly 0
        uint256 remainingAfter = offer.remainingAmount - fillAmount;
        if (remainingAfter > 0) {
            require(remainingAfter >= offer.minFillAmount, "DAX_OfferPool: Remaining slice would leave dust below minimum");
        }

        // Derive childTermsHash mathematically from parent offerTermsHash
        bytes32 childTermsHash = keccak256(
            abi.encodePacked(
                offer.offerTermsHash,
                offer.creator,
                msg.sender,
                fillAmount,
                offer.durationSeconds
            )
        );

        // Update remaining pool amount & state
        offer.remainingAmount = remainingAfter;
        if (remainingAfter == 0) {
            offer.state = OfferState.FULFILLED;
        } else {
            offer.state = OfferState.PARTIALLY_FILLED;
        }

        // Force approve DAX_Agreement and transfer fillAmount into DAX_Agreement
        IERC20(offer.tokenAddress).forceApprove(agreementContract, fillAmount);

        childAgreementId = IDAXAgreementTarget(agreementContract).createAndFundAgreement(
            payable(msg.sender), // Party B (Acceptor)
            offer.tokenAddress,
            fillAmount,
            childTermsHash,
            bytes32(0),
            1,
            offer.durationSeconds,
            sliceSalt
        );

        childAgreements[offerId].push(childAgreementId);

        emit OfferSliceAccepted(
            offerId,
            childAgreementId,
            msg.sender,
            fillAmount,
            childTermsHash,
            offer.remainingAmount
        );
    }

    /**
     * @notice Cancel an active offer pool and refund unaccepted remaining liquidity to creator.
     */
    function cancelOffer(bytes32 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(msg.sender == offer.creator, "DAX_OfferPool: Caller is not creator");
        require(offer.state == OfferState.OPEN || offer.state == OfferState.PARTIALLY_FILLED, "DAX_OfferPool: Offer not active");

        uint256 refundAmount = offer.remainingAmount;
        offer.remainingAmount = 0;
        offer.state = OfferState.CANCELLED;

        if (refundAmount > 0) {
            IERC20(offer.tokenAddress).safeTransfer(offer.creator, refundAmount);
        }

        emit OfferCancelled(offerId, msg.sender, refundAmount);
    }

    /**
     * @notice Claim unaccepted remaining liquidity after offer pool has expired.
     */
    function claimExpiredUnused(bytes32 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(msg.sender == offer.creator, "DAX_OfferPool: Caller is not creator");
        require(block.timestamp >= offer.expiresAt, "DAX_OfferPool: Offer not expired yet");
        require(offer.state == OfferState.OPEN || offer.state == OfferState.PARTIALLY_FILLED, "DAX_OfferPool: Offer not active");

        uint256 refundAmount = offer.remainingAmount;
        offer.remainingAmount = 0;
        offer.state = OfferState.CANCELLED;

        if (refundAmount > 0) {
            IERC20(offer.tokenAddress).safeTransfer(offer.creator, refundAmount);
        }

        emit ExpiredFundsClaimed(offerId, msg.sender, refundAmount);
    }

    /**
     * @notice View helper to get child agreement IDs generated by an offer pool.
     */
    function getChildAgreements(bytes32 offerId) external view returns (bytes32[] memory) {
        return childAgreements[offerId];
    }
}
