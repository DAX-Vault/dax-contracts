// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDAX_Court {
    enum TrialState { NON_EXISTENT, JURY_FORMED, VOTING_COMMIT, VOTING_REVEAL, RESOLVED }

    event JurorStaked(address indexed juror, uint256 amount);
    event JurorUnstaked(address indexed juror, uint256 amount);
    event TrialFormed(uint256 indexed disputeId, bytes32 indexed agreementId, address[] jurors);
    event VoteCommitted(uint256 indexed disputeId, address indexed juror);
    event VoteRevealed(uint256 indexed disputeId, address indexed juror, uint8 verdict);
    event TrialFinalized(uint256 indexed disputeId, uint8 winningVerdict, uint256 partyAAmount, uint256 partyBAmount);
    event PlatformAuthorityResolved(uint256 indexed disputeId, uint8 winningVerdict, uint256 partyAAmount, uint256 partyBAmount);

    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;
    function initializeTrial(bytes32 agreementId) external returns (uint256);
    function commitVote(uint256 disputeId, bytes32 commitHash) external;
    function revealVote(uint256 disputeId, uint8 verdict, bytes32 secret) external;
    function finalizeTrial(uint256 disputeId) external;
}
