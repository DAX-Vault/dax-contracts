// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IDAXAgreementTarget {
    function resolveDispute(bytes32 agreementId, uint256 partyAAmount, uint256 partyBAmount) external;
    function agreements(bytes32 agreementId) external view returns (
        bytes32 id, address partyA, address partyB, address tokenAddress,
        uint256 amount, bytes32 termsHash, uint64 createdAt, uint64 expiresAt,
        uint8 state, bytes32 evidenceRoot, uint256 disputeId
    );
}

/**
 * @title DAX_Court
 * @notice Permissionless, stake-secured Commit-Reveal Arbitration Engine for DAX V2 Agreements.
 * @dev Enforces 1 Juror = 1 Vote democratic arbitration with slashing penalties for minority voters.
 */
contract DAX_Court is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TrialState { NON_EXISTENT, JURY_FORMED, VOTING_COMMIT, VOTING_REVEAL, RESOLVED }

    struct Trial {
        uint256 disputeId;
        bytes32 agreementId;
        address partyA;
        address partyB;
        uint256 escrowAmount;
        address tokenAddress;
        uint64 commitDeadline;
        uint64 revealDeadline;
        TrialState state;
        uint8 winningVerdict; // 1: BUYER_WINS, 2: SELLER_WINS, 3: SPLIT_50_50
        address[] assignedJurors;
        uint256 votesBuyer;
        uint256 votesSeller;
        uint256 votesSplit;
    }

    IERC20 public immutable daxToken;
    address public agreementContract;
    uint256 public minStake = 100 * 10**18; // 100 DAX tokens
    uint256 public slashingBps = 1000;      // 10% slashing penalty for losing voters

    // Juror Staking Registry
    mapping(address => uint256) public jurorStakes;
    mapping(address => uint256) public activeTrialLocks;
    address[] public stakersPool;

    // Trial Records
    mapping(uint256 => Trial) public trials;
    mapping(uint256 => mapping(address => bytes32)) public commitHashes;
    mapping(uint256 => mapping(address => uint8)) public revealedVotes;
    mapping(uint256 => mapping(address => bool)) public hasRevealed;

    // Events
    event JurorStaked(address indexed juror, uint256 amount);
    event JurorUnstaked(address indexed juror, uint256 amount);
    event TrialFormed(uint256 indexed disputeId, bytes32 indexed agreementId, address[] jurors);
    event VoteCommitted(uint256 indexed disputeId, address indexed juror);
    event VoteRevealed(uint256 indexed disputeId, address indexed juror, uint8 verdict);
    event TrialFinalized(uint256 indexed disputeId, uint8 winningVerdict, uint256 partyAAmount, uint256 partyBAmount);

    constructor(address _daxToken) {
        require(_daxToken != address(0), "DAX_Court: Invalid token");
        daxToken = IERC20(_daxToken);
    }

    function setAgreementContract(address _agreementContract) external {
        require(agreementContract == address(0), "DAX_Court: Agreement contract already set");
        agreementContract = _agreementContract;
    }

    // --- Juror Staking ---

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "DAX_Court: Stake amount must be > 0");
        uint256 balBefore = daxToken.balanceOf(address(this));
        daxToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balAfter = daxToken.balanceOf(address(this));
        uint256 actualAmount = balAfter - balBefore;

        if (jurorStakes[msg.sender] == 0) {
            stakersPool.push(msg.sender);
        }
        jurorStakes[msg.sender] += actualAmount;
        emit JurorStaked(msg.sender, actualAmount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(jurorStakes[msg.sender] >= amount, "DAX_Court: Insufficient stake");
        require(activeTrialLocks[msg.sender] == 0, "DAX_Court: Stake locked in active trials");
        require(jurorStakes[msg.sender] - amount >= minStake || jurorStakes[msg.sender] - amount == 0, "DAX_Court: Below minStake requirement");

        jurorStakes[msg.sender] -= amount;
        daxToken.safeTransfer(msg.sender, amount);
        emit JurorUnstaked(msg.sender, amount);
    }

    // --- Jury Formation & Dispute Initiation ---

    function initializeTrial(
        bytes32 agreementId
    ) external nonReentrant returns (uint256) {
        (
            , address partyA, address partyB, address tokenAddress,
            uint256 amount, , , ,
            uint8 state, , uint256 disputeId
        ) = IDAXAgreementTarget(agreementContract).agreements(agreementId);

        require(state == 3, "DAX_Court: Agreement not in DISPUTED state");
        require(disputeId > 0, "DAX_Court: Invalid dispute ID");
        require(trials[disputeId].state == TrialState.NON_EXISTENT, "DAX_Court: Trial already exists");
        require(stakersPool.length >= 3, "DAX_Court: Insufficient stakers pool");

        // Pseudo-random selection of 3 eligible jurors
        address[] memory selectedJurors = new address[](3);
        uint256 found = 0;
        uint256 seed = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, agreementId)));

        for (uint256 i = 0; i < stakersPool.length && found < 3; i++) {
            uint256 candidateIdx = (seed + i) % stakersPool.length;
            address candidate = stakersPool[candidateIdx];

            if (candidate != partyA && candidate != partyB && jurorStakes[candidate] >= minStake) {
                // Ensure unique selection
                bool alreadySelected = false;
                for (uint256 j = 0; j < found; j++) {
                    if (selectedJurors[j] == candidate) {
                        alreadySelected = true;
                        break;
                    }
                }
                if (!alreadySelected) {
                    selectedJurors[found] = candidate;
                    activeTrialLocks[candidate]++;
                    found++;
                }
            }
        }

        require(found == 3, "DAX_Court: Could not find 3 eligible jurors");

        uint64 nowTs = uint64(block.timestamp);
        trials[disputeId] = Trial({
            disputeId: disputeId,
            agreementId: agreementId,
            partyA: partyA,
            partyB: partyB,
            escrowAmount: amount,
            tokenAddress: tokenAddress,
            commitDeadline: nowTs + 86400,   // 24 hours commit window
            revealDeadline: nowTs + 172800,  // 24 hours reveal window
            state: TrialState.VOTING_COMMIT,
            winningVerdict: 0,
            assignedJurors: selectedJurors,
            votesBuyer: 0,
            votesSeller: 0,
            votesSplit: 0
        });

        emit TrialFormed(disputeId, agreementId, selectedJurors);
        return disputeId;
    }

    // --- Commit / Reveal Voting Engine ---

    function commitVote(uint256 disputeId, bytes32 commitHash) external nonReentrant {
        Trial storage t = trials[disputeId];
        require(t.state == TrialState.VOTING_COMMIT, "DAX_Court: Not in commit window");
        require(block.timestamp <= t.commitDeadline, "DAX_Court: Commit window closed");
        require(_isJurorAssigned(disputeId, msg.sender), "DAX_Court: Caller is not an assigned juror");
        require(commitHashes[disputeId][msg.sender] == bytes32(0), "DAX_Court: Vote already committed");

        commitHashes[disputeId][msg.sender] = commitHash;
        emit VoteCommitted(disputeId, msg.sender);
    }

    function revealVote(uint256 disputeId, uint8 verdict, bytes32 secret) external nonReentrant {
        Trial storage t = trials[disputeId];
        if (block.timestamp > t.commitDeadline && t.state == TrialState.VOTING_COMMIT) {
            t.state = TrialState.VOTING_REVEAL;
        }
        require(t.state == TrialState.VOTING_REVEAL, "DAX_Court: Not in reveal window");
        require(block.timestamp <= t.revealDeadline, "DAX_Court: Reveal window closed");
        require(_isJurorAssigned(disputeId, msg.sender), "DAX_Court: Caller is not an assigned juror");
        require(!hasRevealed[disputeId][msg.sender], "DAX_Court: Vote already revealed");

        bytes32 expectedHash = keccak256(abi.encodePacked(verdict, secret, msg.sender, disputeId));
        require(commitHashes[disputeId][msg.sender] == expectedHash, "DAX_Court: Commit hash mismatch");
        require(verdict >= 1 && verdict <= 3, "DAX_Court: Invalid verdict code");

        hasRevealed[disputeId][msg.sender] = true;
        revealedVotes[disputeId][msg.sender] = verdict;

        if (verdict == 1) t.votesBuyer++;
        else if (verdict == 2) t.votesSeller++;
        else if (verdict == 3) t.votesSplit++;

        emit VoteRevealed(disputeId, msg.sender, verdict);
    }

    // --- Finalization & Slashing ---

    function finalizeDispute(uint256 disputeId) external nonReentrant {
        Trial storage t = trials[disputeId];
        require(t.state == TrialState.VOTING_REVEAL || t.state == TrialState.VOTING_COMMIT, "DAX_Court: Invalid trial state");
        require(block.timestamp > t.revealDeadline, "DAX_Court: Reveal window still open");

        // Determine majority verdict
        uint8 winning = 3; // Default SPLIT_50_50
        if (t.votesBuyer > t.votesSeller && t.votesBuyer > t.votesSplit) {
            winning = 1; // BUYER_WINS
        } else if (t.votesSeller > t.votesBuyer && t.votesSeller > t.votesSplit) {
            winning = 2; // SELLER_WINS
        }

        t.winningVerdict = winning;
        t.state = TrialState.RESOLVED;

        // Unlock juror trial locks & execute slashing
        for (uint256 i = 0; i < t.assignedJurors.length; i++) {
            address juror = t.assignedJurors[i];
            if (activeTrialLocks[juror] > 0) {
                activeTrialLocks[juror]--;
            }

            // Slash minority voters
            if (hasRevealed[disputeId][juror] && revealedVotes[disputeId][juror] != winning) {
                uint256 slashAmt = (jurorStakes[juror] * slashingBps) / 10000;
                jurorStakes[juror] -= slashAmt;
            }
        }

        // Calculate settlement split
        uint256 partyAAmount = 0;
        uint256 partyBAmount = 0;

        if (winning == 1) {
            partyAAmount = t.escrowAmount;
        } else if (winning == 2) {
            partyBAmount = t.escrowAmount;
        } else {
            partyAAmount = t.escrowAmount / 2;
            partyBAmount = t.escrowAmount - partyAAmount;
        }

        // Execute settlement on DAX_Agreement
        IDAXAgreementTarget(agreementContract).resolveDispute(t.agreementId, partyAAmount, partyBAmount);

        emit TrialFinalized(disputeId, winning, partyAAmount, partyBAmount);
    }

    // --- Helpers ---

    function _isJurorAssigned(uint256 disputeId, address juror) internal view returns (bool) {
        Trial storage t = trials[disputeId];
        for (uint256 i = 0; i < t.assignedJurors.length; i++) {
            if (t.assignedJurors[i] == juror) return true;
        }
        return false;
    }
}
