// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title DAX_Agreement
 * @notice Universal Trustless Agreement & Settlement Protocol.
 * @dev Enforces 10 Security Invariants (INV-01 to INV-10).
 * Implements EIP-712 typed authorizations, EIP-2612 Permit funding,
 * and ERC-2771 Gasless Meta-Transactions.
 */
contract DAX_Agreement is Context, ReentrancyGuard, EIP712, ERC2771Context {
    using SafeERC20 for IERC20;

    // --- State Machine Enum ---
    enum AgreementState {
        NON_EXISTENT, // 0
        ACTIVE,       // 1: Created & Funded
        SETTLED,      // 2: Completed & Released
        DISPUTED,     // 3: Escalated to Dispute Arbitration
        RESOLVED,     // 4: Dispute Verdict Executed
        REFUNDED      // 5: Cancelled or Expired Refund
    }

    // --- Agreement Core Data Struct ---
    struct Agreement {
        bytes32 agreementId;         // Unique keccak256 hash
        address payable partyA;      // Buyer / Client (Initiator)
        address payable partyB;      // Seller / Provider (Counterparty)
        address tokenAddress;        // ERC-20 asset (address(0) for native ETH)
        uint256 amount;              // Escrowed principal amount
        bytes32 termsHash;           // SHA-256 / IPFS hash of immutable terms
        uint64 createdAt;            // Creation timestamp
        uint64 expiresAt;            // Deliverable deadline timestamp
        AgreementState state;        // Current state enum
        bytes32 evidenceRoot;        // Merkle root / IPFS hash of committed evidence
        uint256 disputeId;           // Arbitration court reference ID (0 if none)
    }

    // --- Typehashes for EIP-712 ---
    bytes32 public constant MUTUAL_CANCEL_TYPEHASH = keccak256(
        "MutualCancel(bytes32 agreementId,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant BUYER_RELEASE_TYPEHASH = keccak256(
        "BuyerRelease(bytes32 agreementId,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
    );

    // --- Storage ---
    address public treasury;
    uint256 public treasuryFeeBps; // 25 = 0.25%, 10000 = 100%
    address public disputeCourt;

    mapping(bytes32 => Agreement) public agreements;
    mapping(address => uint256) public nonces;

    // --- Events ---
    event AgreementCreated(
        bytes32 indexed agreementId,
        address indexed partyA,
        address indexed partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        uint64 expiresAt
    );

    event AgreementSettled(
        bytes32 indexed agreementId,
        address indexed partyB,
        uint256 payoutAmount,
        uint256 feeAmount,
        bytes32 evidenceHash
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
        address indexed partyA,
        address indexed partyB,
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

    // --- Constructor ---
    constructor(
        address _treasury,
        uint256 _treasuryFeeBps,
        address _disputeCourt,
        address _trustedForwarder
    )
        EIP712("DAX Agreement Protocol", "1.0.0")
        ERC2771Context(_trustedForwarder)
    {
        require(_treasury != address(0), "DAX: Invalid treasury");
        require(_treasuryFeeBps <= 250, "DAX: Fee cannot exceed 2.5%");
        treasury = _treasury;
        treasuryFeeBps = _treasuryFeeBps;
        disputeCourt = _disputeCourt;
    }

    // --- ERC2771 Overrides ---
    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }

    // --- Core Functions ---

    /**
     * @notice Atomic Agreement Creation & Funding (Standard ERC-20 approve path or native ETH).
     * Enforces INV-03, INV-04, INV-05, INV-10.
     */
    function createAndFundAgreement(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        uint64 durationSeconds,
        bytes32 salt
    ) external payable nonReentrant returns (bytes32 agreementId) {
        address payable partyA = payable(_msgSender());
        require(partyB != address(0) && partyB != partyA, "DAX: Invalid counterparty");
        require(amount > 0, "DAX: Amount must be > 0");
        require(termsHash != bytes32(0), "DAX: Invalid terms hash");
        require(durationSeconds >= 300, "DAX: Duration must be >= 5 mins");

        agreementId = keccak256(abi.encodePacked(partyA, partyB, termsHash, salt, block.chainid));
        require(agreements[agreementId].state == AgreementState.NON_EXISTENT, "DAX: Agreement ID collision");

        uint64 expiresAt = uint64(block.timestamp + durationSeconds);

        agreements[agreementId] = Agreement({
            agreementId: agreementId,
            partyA: partyA,
            partyB: partyB,
            tokenAddress: tokenAddress,
            amount: amount,
            termsHash: termsHash,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            state: AgreementState.ACTIVE,
            evidenceRoot: bytes32(0),
            disputeId: 0
        });

        // Escrow Asset Deposit
        if (tokenAddress == address(0)) {
            require(msg.value == amount, "DAX: ETH amount mismatch");
        } else {
            require(msg.value == 0, "DAX: ETH not accepted for token escrow");
            uint256 balBefore = IERC20(tokenAddress).balanceOf(address(this));
            IERC20(tokenAddress).safeTransferFrom(partyA, address(this), amount);
            uint256 balAfter = IERC20(tokenAddress).balanceOf(address(this));
            require(balAfter - balBefore == amount, "DAX: Fee-on-transfer tokens not supported");
        }

        emit AgreementCreated(agreementId, partyA, partyB, tokenAddress, amount, termsHash, expiresAt);
    }

    /**
     * @notice Atomic Agreement Creation & Funding using EIP-2612 Permit (1-Tx Funding for USDC/DAI).
     */
    function createAndFundWithPermit(
        address payable partyB,
        address tokenAddress,
        uint256 amount,
        bytes32 termsHash,
        uint64 durationSeconds,
        bytes32 salt,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 agreementId) {
        address payable partyA = payable(_msgSender());
        require(tokenAddress != address(0), "DAX: Permit requires ERC20 token");

        // Execute EIP-2612 Permit
        IERC20Permit(tokenAddress).permit(partyA, address(this), amount, permitDeadline, v, r, s);

        // Execute Creation & Funding
        require(partyB != address(0) && partyB != partyA, "DAX: Invalid counterparty");
        require(amount > 0, "DAX: Amount must be > 0");
        require(termsHash != bytes32(0), "DAX: Invalid terms hash");
        require(durationSeconds >= 300, "DAX: Duration must be >= 5 mins");

        agreementId = keccak256(abi.encodePacked(partyA, partyB, termsHash, salt, block.chainid));
        require(agreements[agreementId].state == AgreementState.NON_EXISTENT, "DAX: Agreement ID collision");

        uint64 expiresAt = uint64(block.timestamp + durationSeconds);

        agreements[agreementId] = Agreement({
            agreementId: agreementId,
            partyA: partyA,
            partyB: partyB,
            tokenAddress: tokenAddress,
            amount: amount,
            termsHash: termsHash,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            state: AgreementState.ACTIVE,
            evidenceRoot: bytes32(0),
            disputeId: 0
        });

        uint256 balBefore = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransferFrom(partyA, address(this), amount);
        uint256 balAfter = IERC20(tokenAddress).balanceOf(address(this));
        require(balAfter - balBefore == amount, "DAX: Fee-on-transfer tokens not supported");

        emit AgreementCreated(agreementId, partyA, partyB, tokenAddress, amount, termsHash, expiresAt);
    }

    /**
     * @notice Submit evidence & release escrow to Party B.
     * Enforces INV-01, INV-02, INV-03.
     * Requires EIP-712 Release Signature from Party A (Buyer). Party B CANNOT release unilaterally.
     */
    function submitAndRelease(
        bytes32 agreementId,
        bytes32 evidenceHash,
        uint256 deadline,
        bytes calldata buyerSignature
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(block.timestamp <= deadline, "DAX: Signature deadline expired");

        // Verify Buyer (Party A) EIP-712 Signature
        bytes32 structHash = keccak256(
            abi.encode(
                BUYER_RELEASE_TYPEHASH,
                agreementId,
                evidenceHash,
                nonces[ag.partyA]++,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, buyerSignature);
        require(signer == ag.partyA, "DAX: Invalid buyer release signature");

        ag.state = AgreementState.SETTLED;
        ag.evidenceRoot = evidenceHash;

        uint256 feeAmount = (ag.amount * treasuryFeeBps) / 10000;
        uint256 payoutAmount = ag.amount - feeAmount;

        _transferAsset(ag.tokenAddress, ag.partyB, payoutAmount);
        if (feeAmount > 0) {
            _transferAsset(ag.tokenAddress, payable(treasury), feeAmount);
        }

        emit AgreementSettled(agreementId, ag.partyB, payoutAmount, feeAmount, evidenceHash);
    }

    /**
     * @notice Instant Mutual Cancellation.
     * Enforces INV-01, INV-02, INV-03, INV-06.
     * Requires EIP-712 signatures from BOTH Party A and Party B. Refunds 100% to Party A without fee.
     */
    function mutualCancel(
        bytes32 agreementId,
        uint256 deadline,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(block.timestamp <= deadline, "DAX: Cancellation deadline expired");

        bytes32 structHashA = keccak256(
            abi.encode(
                MUTUAL_CANCEL_TYPEHASH,
                agreementId,
                nonces[ag.partyA]++,
                deadline
            )
        );
        bytes32 structHashB = keccak256(
            abi.encode(
                MUTUAL_CANCEL_TYPEHASH,
                agreementId,
                nonces[ag.partyB]++,
                deadline
            )
        );

        address signerA = ECDSA.recover(_hashTypedDataV4(structHashA), sigA);
        address signerB = ECDSA.recover(_hashTypedDataV4(structHashB), sigB);

        require(signerA == ag.partyA, "DAX: Invalid Party A cancel signature");
        require(signerB == ag.partyB, "DAX: Invalid Party B cancel signature");

        ag.state = AgreementState.REFUNDED;

        _transferAsset(ag.tokenAddress, ag.partyA, ag.amount);

        emit AgreementRefunded(agreementId, ag.partyA, ag.amount, "Mutual Cancellation");
    }

    /**
     * @notice Claim Expired Agreement Refund.
     * Enforces INV-01, INV-05, INV-07.
     * Allows Party A to claim 100% refund if deadline passed without completion or dispute.
     */
    function claimExpiredRefund(bytes32 agreementId) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");
        require(_msgSender() == ag.partyA, "DAX: Only Party A can claim expired refund");
        require(block.timestamp > ag.expiresAt, "DAX: Agreement has not expired yet");

        ag.state = AgreementState.REFUNDED;

        _transferAsset(ag.tokenAddress, ag.partyA, ag.amount);

        emit AgreementRefunded(agreementId, ag.partyA, ag.amount, "Agreement Expired");
    }

    /**
     * @notice Escalate Agreement to Dispute Court.
     * Enforces INV-01.
     */
    function raiseDispute(bytes32 agreementId, bytes32 evidenceHash) external onlyParties(agreementId) nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.ACTIVE, "DAX: Agreement not active");

        ag.state = AgreementState.DISPUTED;
        ag.evidenceRoot = evidenceHash;
        ag.disputeId = uint256(keccak256(abi.encodePacked(agreementId, block.timestamp)));

        emit DisputeRaised(agreementId, _msgSender(), ag.disputeId);
    }

    /**
     * @notice Execute Dispute Resolution Verdict.
     * Enforces INV-02, INV-03, INV-08, INV-09.
     * Callable ONLY by the designated Dispute Court contract.
     */
    function resolveDispute(
        bytes32 agreementId,
        uint256 partyAAmount,
        uint256 partyBAmount
    ) external onlyCourt nonReentrant {
        Agreement storage ag = agreements[agreementId];
        require(ag.state == AgreementState.DISPUTED, "DAX: Agreement not in dispute");
        require(partyAAmount + partyBAmount == ag.amount, "DAX: Dispute amounts sum mismatch");

        ag.state = AgreementState.RESOLVED;

        if (partyAAmount > 0) {
            _transferAsset(ag.tokenAddress, ag.partyA, partyAAmount);
        }
        if (partyBAmount > 0) {
            uint256 feeAmount = (partyBAmount * treasuryFeeBps) / 10000;
            uint256 netPartyB = partyBAmount - feeAmount;
            _transferAsset(ag.tokenAddress, ag.partyB, netPartyB);
            if (feeAmount > 0) {
                _transferAsset(ag.tokenAddress, payable(treasury), feeAmount);
            }
        }

        emit DisputeResolved(agreementId, ag.partyA, ag.partyB, partyAAmount, partyBAmount);
    }

    // --- Admin Governance Functions ---

    function setTreasury(address _newTreasury, uint256 _newFeeBps) external {
        require(_msgSender() == treasury, "DAX: Admin treasury only");
        require(_newTreasury != address(0), "DAX: Invalid treasury");
        require(_newFeeBps <= 250, "DAX: Fee cannot exceed 2.5%");
        treasury = _newTreasury;
        treasuryFeeBps = _newFeeBps;
        emit TreasuryUpdated(_newTreasury, _newFeeBps);
    }

    function setDisputeCourt(address _newCourt) external {
        require(_msgSender() == treasury, "DAX: Admin treasury only");
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
}
