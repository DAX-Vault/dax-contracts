// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDAX_Agreement {
    enum AgreementState {
        NON_EXISTENT,
        ACTIVE,
        SETTLED,
        DISPUTED,
        RESOLVED,
        REFUNDED,
        PENDING
    }

    struct Agreement {
        bytes32 agreementId;
        address payable partyA;
        address partyB;
        address tokenAddress;
        uint256 totalAmount;
        uint256 releasedAmount;
        bytes32 termsHash;
        bytes32 scheduleHash;
        uint256 periodCount;
        uint256 currentPeriod;
        uint64 createdAt;
        uint64 expiresAt;
        AgreementState state;
        bytes32 evidenceRoot;
        uint256 disputeId;
        uint256 totalFeePaid;
        uint16 feeBps;
    }

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

    event AgreementFunded(bytes32 indexed agreementId, address indexed funder, uint256 amount);
    event PeriodReleased(bytes32 indexed agreementId, uint256 indexed periodIndex, uint256 netPayout, uint256 feeAmount, bytes32 evidenceHash);
    event AgreementSettled(bytes32 indexed agreementId, address indexed partyB, uint256 totalReleased, uint256 totalFeePaid);
    event AgreementDisputed(bytes32 indexed agreementId, uint256 indexed disputeId, address indexed initiator);
    event DisputeResolved(bytes32 indexed agreementId, uint256 indexed disputeId, uint256 partyAAmount, uint256 partyBAmount);
    event AgreementRefunded(bytes32 indexed agreementId, address indexed partyA, uint256 refundAmount, string reason);

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

    function resolveDispute(bytes32 agreementId, uint256 disputeId, uint256 partyAAmount, uint256 partyBAmount) external;

    function agreements(bytes32 agreementId) external view returns (
        bytes32 id, address partyA, address partyB, address tokenAddress,
        uint256 totalAmount, uint256 releasedAmount, bytes32 termsHash,
        bytes32 scheduleHash, uint256 periodCount, uint256 currentPeriod,
        uint64 createdAt, uint64 expiresAt,
        uint8 state, bytes32 evidenceRoot, uint256 disputeId
    );
}
