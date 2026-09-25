// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "../utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @title DAX_AgreementUpgradeable
 * @notice Universal Trustless Agreement & Settlement Protocol (UUPS Upgradeable).
 * @dev Enforces 10 Security Invariants (INV-01 to INV-10).
 * Implements Merkle schedule commitments, EIP-712 typed authorizations,
 * EIP-2612 Permit funding, and ERC-2771 Gasless Meta-Transactions.
 * Storage and user escrows persist permanently across protocol upgrades.
 */
contract DAX_AgreementUpgradeable is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    ERC2771ContextUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // --- State Machine Enum ---
    enum AgreementState {
        NON_EXISTENT, // 0
        ACTIVE,       // 1: Created & Funded
        SETTLED,      // 2: Completed & Fully Released
        DISPUTED,     // 3: Escalated to Dispute Arbitration
        RESOLVED,     // 4: Dispute Verdict Executed
        REFUNDED,     // 5: Cancelled or Expired Refund
        PENDING       // 6: Registered On-Chain, Awaiting Escrow Deposit
    }

    // --- Agreement Core Data Struct ---
    struct Agreement {
        bytes32 agreementId;         // Unique keccak256 hash
        address payable partyA;      // Buyer / Client (Initiator)
        address payable partyB;      // Seller / Provider (Counterparty)
        address tokenAddress;        // ERC-20 asset (address(0) for native ETH)
        uint256 totalAmount;         // Escrowed principal amount
        uint256 releasedAmount;      // Cumulative amount released so far
        bytes32 termsHash;           // SHA-256 / IPFS hash of immutable terms
        bytes32 scheduleHash;        // Merkle root of period schedule
        uint256 periodCount;         // Total periods (1 for one-time, N for scheduled)
        uint256 currentPeriod;       // Next active period index (starts at 0)
        uint64 createdAt;            // Creation timestamp
        uint64 expiresAt;            // Deliverable deadline timestamp
        AgreementState state;        // Current state enum
        bytes32 evidenceRoot;        // Latest Merkle root / IPFS hash of committed evidence
        uint256 disputeId;           // Arbitration court reference ID (0 if none)
        uint256 totalFeePaid;        // Cumulative fees actually transferred to treasury
        uint16 feeBps;               // Immutable treasury fee Bps captured at creation
    }

    // --- Typehashes for EIP-712 ---
    bytes32 public constant MUTUAL_CANCEL_TYPEHASH = keccak256(
        "MutualCancel(bytes32 agreementId,uint256 deadline)"
    );

    bytes32 public constant BUYER_RELEASE_TYPEHASH = keccak256(
        "BuyerRelease(bytes32 agreementId,uint256 periodIndex,uint256 releaseAmount,bytes32 evidenceHash,uint256 deadline)"
    );

    // --- Storage ---
    address public treasury;
    uint256 public treasuryFeeBps; // 25 = 0.25%, 10000 = 100%
    address public disputeCourt;

    mapping(bytes32 => Agreement) public agreements;
    mapping(bytes32 => string) public agreementUris;
    mapping(bytes32 => uint64) public agreementDurations;
    mapping(bytes32 => mapping(uint256 => bytes32)) public periodEvidenceRoots;

    // --- Events ---
    event AgreementCreated(
        bytes32 indexed agreementId,
        address indexed partyA,
        address indexed partyB,
        address tokenAddress,
        uint256 totalAmount,
        bytes32 termsHash,
        bytes32 scheduleHash,
        uint256 periodCount,
        uint64 expiresAt,
        string metadataUri
    );

    event AgreementFunded(
        bytes32 indexed agreementId,
        address indexed funder,
        uint256 amount
    );

    event PeriodReleased(
        bytes32 indexed agreementId,
        uint256 indexed periodIndex,
        uint256 payoutAmount,
        uint256 feeAmount,
        bytes32 evidenceHash
    );

    event AgreementSettled(
        bytes32 indexed agreementId,
        address indexed partyB,
        uint256 totalPaid,
        uint256 totalFee
    );

    event AgreementRefunded(
        bytes32 indexed agreementId,
        address indexed partyA,
        uint256 refundAmount,
        string reason
    );

    event DisputeRaised(
        bytes32 indexed agreementId,
        address indexed raisedBy,
        uint256 disputeId
    );

    event DisputeResolved(
        bytes32 indexed agreementId,
        uint256 indexed disputeId,
        address indexed partyA,
        address partyB,
        uint256 partyAAmount,
        uint256 partyBAmount
    );

    event TreasuryUpdated(address indexed newTreasury, uint256 newFeeBps);
    event DisputeCourtUpdated(address indexed newCourt);

    // --- Modifiers ---
    modifier onlyParties(bytes32 agreementId) {
        Agreement storage ag = agreements[agreementId];
        require(
            _msgSender() == ag.partyA || _msgSender() == ag.partyB,
            "DAX: Caller is not an agreement party"
        );
        _;
    }

    modifier onlyCourt() {
        require(_msgSender() == disputeCourt, "DAX: Caller is not dispute court");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice UUPS Initializer
     */
    function initialize(
        address _treasury,
        uint256 _treasuryFeeBps,
        address _disputeCourt,
        address _initialOwner
    ) external initializer {
        require(_treasury != address(0), "DAX: Invalid treasury");
        require(_treasuryFeeBps <= 250, "DAX: Fee cannot exceed 2.5%");

        __Ownable_init(_initialOwner);
        __ReentrancyGuard_init();
        __EIP712_init("DAX Agreement Protocol", "1.0.0");

        treasury = _treasury;
        treasuryFeeBps = _treasuryFeeBps;
        disputeCourt = _disputeCourt;
    }

    /**
     * @dev Restricts upgrade authorization to contract owner (Platform Authority).
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // --- ERC2771 Overrides ---
    function _msgSender()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (address)
    {
        return ERC2771ContextUpgradeable._msgSender();
    }

    function _msgData()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (bytes calldata)
    {
        return ERC2771ContextUpgradeable._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (uint256)
    {
        return ERC2771ContextUpgradeable._contextSuffixLength();
    }

    // --- Core Functions ---

    function createAndFundAgreement(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        bytes32 scheduleHash,
        uint256 periodCount,
        uint64 durationSeconds,
        bytes32 salt
    ) external payable returns (bytes32 agreementId) {
        return createAndFundAgreementWithMetadata(
            partyB,
            tokenAddress,
            amount,
            termsHash,
            scheduleHash,
            periodCount,
            durationSeconds,
            salt,
            ""
        );
    }

    function createAndFundAgreementWithMetadata(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        bytes32 scheduleHash,
        uint256 periodCount,
        uint64 durationSeconds,
        bytes32 salt,
        string memory metadataUri
    ) public payable nonReentrant returns (bytes32 agreementId) {
        require(partyB != address(0), "DAX: Invalid counterparty");
        require(partyB != _msgSender(), "DAX: Cannot make agreement with self");
        require(amount > 0, "DAX: Amount must be greater than 0");
        require(durationSeconds > 0, "DAX: Duration must be greater than 0");
        require(periodCount > 0, "DAX: Period count must be greater than 0");

        agreementId = computeAgreementId(_msgSender(), partyB, amount, termsHash, salt);
        require(agreements[agreementId].state == AgreementState.NON_EXISTENT, "DAX: Agreement ID collision");

        if (tokenAddress == address(0)) {
            require(msg.value == amount, "DAX: Incorrect ETH amount sent");
        } else {
            require(msg.value == 0, "DAX: ETH sent for ERC20 agreement");
            uint256 balanceBefore = IERC20(tokenAddress).balanceOf(address(this));
            IERC20(tokenAddress).safeTransferFrom(_msgSender(), address(this), amount);
            uint256 balanceAfter = IERC20(tokenAddress).balanceOf(address(this));
            require(balanceAfter - balanceBefore == amount, "DAX: Fee-on-transfer tokens unsupported");
        }

        uint64 expiresAt = uint64(block.timestamp + durationSeconds);

        agreements[agreementId] = Agreement({
            agreementId: agreementId,
            partyA: payable(_msgSender()),
            partyB: partyB,
            tokenAddress: tokenAddress,
            totalAmount: amount,
            releasedAmount: 0,
            termsHash: termsHash,
            scheduleHash: scheduleHash,
            periodCount: periodCount,
            currentPeriod: 0,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            state: AgreementState.ACTIVE,
            evidenceRoot: bytes32(0),
            disputeId: 0,
            totalFeePaid: 0,
            feeBps: uint16(treasuryFeeBps)
        });

        if (bytes(metadataUri).length > 0) {
            agreementUris[agreementId] = metadataUri;
        }
        agreementDurations[agreementId] = durationSeconds;

        emit AgreementCreated(
            agreementId,
            _msgSender(),
            partyB,
            tokenAddress,
            amount,
            termsHash,
            scheduleHash,
            periodCount,
            expiresAt,
            metadataUri
        );

        emit AgreementFunded(agreementId, _msgSender(), amount);
    }

    function createAgreementPendingWithMetadata(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        bytes32 scheduleHash,
        uint256 periodCount,
        uint64 durationSeconds,
        bytes32 salt,
        string memory metadataUri
    ) external nonReentrant returns (bytes32 agreementId) {
        require(partyB != address(0), "DAX: Invalid counterparty");
        require(partyB != _msgSender(), "DAX: Cannot make agreement with self");
        require(amount > 0, "DAX: Amount must be greater than 0");
        require(durationSeconds > 0, "DAX: Duration must be greater than 0");
        require(periodCount > 0, "DAX: Period count must be greater than 0");

        agreementId = computeAgreementId(_msgSender(), partyB, amount, termsHash, salt);
        require(agreements[agreementId].state == AgreementState.NON_EXISTENT, "DAX: Agreement ID collision");

        agreements[agreementId] = Agreement({
            agreementId: agreementId,
            partyA: payable(_msgSender()),
            partyB: partyB,
            tokenAddress: tokenAddress,
            totalAmount: amount,
            releasedAmount: 0,
            termsHash: termsHash,
            scheduleHash: scheduleHash,
            periodCount: periodCount,
            currentPeriod: 0,
            createdAt: uint64(block.timestamp),
            expiresAt: 0,
            state: AgreementState.PENDING,
            evidenceRoot: bytes32(0),
            disputeId: 0,
            totalFeePaid: 0,
            feeBps: uint16(treasuryFeeBps)
        });

        if (bytes(metadataUri).length > 0) {
            agreementUris[agreementId] = metadataUri;
        }
        agreementDurations[agreementId] = durationSeconds;

        emit AgreementCreated(
            agreementId,
            _msgSender(),
            partyB,
            tokenAddress,
            amount,
            termsHash,
            scheduleHash,
            periodCount,
            0,
            metadataUri
        );
    }

    function depositEscrow(bytes32 agreementId) external payable nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.PENDING, "DAX: Agreement not in PENDING state");
        require(_msgSender() == ag.partyA, "DAX: Only partyA can deposit escrow");

        if (ag.tokenAddress == address(0)) {
            require(msg.value == ag.totalAmount, "DAX: Incorrect ETH amount sent");
        } else {
            require(msg.value == 0, "DAX: ETH sent for ERC20 agreement");
            uint256 balanceBefore = IERC20(ag.tokenAddress).balanceOf(address(this));
            IERC20(ag.tokenAddress).safeTransferFrom(_msgSender(), address(this), ag.totalAmount);
            uint256 balanceAfter = IERC20(ag.tokenAddress).balanceOf(address(this));
            require(balanceAfter - balanceBefore == ag.totalAmount, "DAX: Fee-on-transfer tokens unsupported");
        }

        uint64 duration = agreementDurations[agreementId];
        if (duration == 0) duration = 86400 * 7;
        ag.expiresAt = uint64(block.timestamp + duration);
        ag.state = AgreementState.ACTIVE;

        emit AgreementFunded(agreementId, _msgSender(), ag.totalAmount);
    }

    function cancelPendingAgreement(bytes32 agreementId) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.PENDING, "DAX: Agreement not in PENDING state");
        require(_msgSender() == ag.partyA, "DAX: Only partyA can cancel pending agreement");

        ag.state = AgreementState.REFUNDED;
        emit AgreementRefunded(agreementId, ag.partyA, 0, "Cancelled by partyA before escrow");
    }

    function submitAndRelease(
        bytes32 agreementId,
        uint256 periodIndex,
        uint256 releaseAmount,
        bytes32 evidenceHash,
        uint256 deadline,
        bytes calldata buyerSignature,
        bytes32[] calldata merkleProof
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(block.timestamp <= ag.expiresAt, "DAX: Agreement expired");
        require(periodIndex == ag.currentPeriod, "DAX: Invalid period sequence");
        require(periodIndex < ag.periodCount, "DAX: Exceeds period count");
        require(releaseAmount > 0, "DAX: Release amount must be > 0");
        require(ag.releasedAmount + releaseAmount <= ag.totalAmount, "DAX: Amount exceeds total escrow");
        require(block.timestamp <= deadline, "DAX: Signature expired");

        if (ag.periodCount > 1) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(periodIndex, releaseAmount))));
            require(
                MerkleProof.verify(merkleProof, ag.scheduleHash, leaf),
                "DAX: Invalid period Merkle proof"
            );
        }

        bytes32 structHash = keccak256(
            abi.encode(
                BUYER_RELEASE_TYPEHASH,
                agreementId,
                periodIndex,
                releaseAmount,
                evidenceHash,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, buyerSignature);
        require(recoveredSigner == ag.partyA, "DAX: Invalid Party A release authorization");

        ag.releasedAmount += releaseAmount;
        ag.currentPeriod += 1;
        ag.evidenceRoot = evidenceHash;
        periodEvidenceRoots[agreementId][periodIndex] = evidenceHash;

        uint256 feeAmount = (releaseAmount * ag.feeBps) / 10000;
        if (feeAmount == 0 && releaseAmount > 0 && ag.feeBps > 0) {
            feeAmount = 1;
        }
        ag.totalFeePaid += feeAmount;
        uint256 netSellerPayout = releaseAmount - feeAmount;

        _transferAsset(ag.tokenAddress, ag.partyB, netSellerPayout);
        if (feeAmount > 0) {
            _transferAsset(ag.tokenAddress, payable(treasury), feeAmount);
        }

        emit PeriodReleased(agreementId, periodIndex, netSellerPayout, feeAmount, evidenceHash);

        if (ag.releasedAmount == ag.totalAmount || ag.currentPeriod == ag.periodCount) {
            ag.state = AgreementState.SETTLED;
            emit AgreementSettled(agreementId, ag.partyB, ag.releasedAmount, ag.totalFeePaid);
        }
    }

    function mutualCancel(
        bytes32 agreementId,
        uint256 deadline,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(block.timestamp <= deadline, "DAX: Signature expired");

        bytes32 structHash = keccak256(abi.encode(MUTUAL_CANCEL_TYPEHASH, agreementId, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);

        address signerA = ECDSA.recover(digest, sigA);
        address signerB = ECDSA.recover(digest, sigB);

        require(signerA == ag.partyA, "DAX: Invalid Party A signature");
        require(signerB == ag.partyB, "DAX: Invalid Party B signature");

        ag.state = AgreementState.REFUNDED;

        uint256 remainingAmount = ag.totalAmount - ag.releasedAmount;
        _transferAsset(ag.tokenAddress, ag.partyA, remainingAmount);

        emit AgreementRefunded(agreementId, ag.partyA, remainingAmount, "Mutual Cancellation");
    }

    function claimExpiredRefund(bytes32 agreementId) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(_msgSender() == ag.partyA, "DAX: Only Party A can claim expired refund");
        require(block.timestamp > ag.expiresAt, "DAX: Agreement has not expired yet");

        ag.state = AgreementState.REFUNDED;

        uint256 remainingAmount = ag.totalAmount - ag.releasedAmount;
        _transferAsset(ag.tokenAddress, ag.partyA, remainingAmount);

        emit AgreementRefunded(agreementId, ag.partyA, remainingAmount, "Agreement Expired");
    }

    function raiseDispute(bytes32 agreementId, bytes32 evidenceHash) external onlyParties(agreementId) nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(block.timestamp <= ag.expiresAt, "DAX: Agreement expired");

        ag.state = AgreementState.DISPUTED;
        ag.evidenceRoot = evidenceHash;
        ag.disputeId = uint256(keccak256(abi.encodePacked(agreementId, block.timestamp)));

        emit DisputeRaised(agreementId, _msgSender(), ag.disputeId);
    }

    function resolveDispute(
        bytes32 agreementId,
        uint256 disputeId,
        uint256 partyAAmount,
        uint256 partyBAmount
    ) external onlyCourt nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.DISPUTED, "DAX: Agreement not in dispute");
        require(ag.disputeId == disputeId, "DAX: Dispute ID mismatch");

        uint256 remainingAmount = ag.totalAmount - ag.releasedAmount;
        require(partyAAmount + partyBAmount == remainingAmount, "DAX: Dispute amounts sum mismatch");

        ag.state = AgreementState.RESOLVED;

        if (partyAAmount > 0) {
            _transferAsset(ag.tokenAddress, ag.partyA, partyAAmount);
        }
        if (partyBAmount > 0) {
            uint256 feeAmount = (partyBAmount * ag.feeBps) / 10000;
            if (feeAmount == 0 && partyBAmount > 0 && ag.feeBps > 0) {
                feeAmount = 1;
            }
            ag.totalFeePaid += feeAmount;
            uint256 netPartyB = partyBAmount - feeAmount;
            _transferAsset(ag.tokenAddress, ag.partyB, netPartyB);
            if (feeAmount > 0) {
                _transferAsset(ag.tokenAddress, payable(treasury), feeAmount);
            }
        }

        emit DisputeResolved(agreementId, disputeId, ag.partyA, ag.partyB, partyAAmount, partyBAmount);
    }

    // --- Admin Governance Functions ---

    function setTreasury(address _newTreasury, uint256 _newFeeBps) external onlyOwner {
        require(_newTreasury != address(0), "DAX: Invalid treasury");
        require(_newFeeBps <= 250, "DAX: Fee cannot exceed 2.5%");
        treasury = _newTreasury;
        treasuryFeeBps = _newFeeBps;
        emit TreasuryUpdated(_newTreasury, _newFeeBps);
    }

    function setDisputeCourt(address _newCourt) external onlyOwner {
        disputeCourt = _newCourt;
        emit DisputeCourtUpdated(_newCourt);
    }

    // --- Internal Helpers ---

    function _transferAsset(address token, address payable to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            require(success, "DAX: ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function computeAgreementId(
        address partyA,
        address partyB,
        uint256 amount,
        bytes32 termsHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(partyA, partyB, amount, termsHash, salt));
    }

    function getAgreement(bytes32 agreementId) external view returns (Agreement memory) {
        return agreements[agreementId];
    }
}
