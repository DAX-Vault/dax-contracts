import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Phase 6: Court V2 Adversarial & Invariant Tests", function () {
  let DAX_Agreement, DAX_Court, MockToken;
  let daxAgreement, daxCourt, daxToken, mockUSDC;
  let owner, treasury, partyA, partyB, juror1, juror2, juror3, attacker;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
  const MIN_STAKE = ethers.parseUnits("100", 18);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Audit Dispute Agreement"));

  beforeEach(async function () {
    [owner, treasury, partyA, partyB, juror1, juror2, juror3, attacker] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    daxToken = await MockTokenFactory.deploy("DAX Token", "DAX", INITIAL_SUPPLY);
    await daxToken.waitForDeployment();

    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseUnits("1000000", 6));
    await mockUSDC.waitForDeployment();

    const CourtFactory = await ethers.getContractFactory("DAX_Court");
    daxCourt = await CourtFactory.deploy(await daxToken.getAddress());
    await daxCourt.waitForDeployment();

    const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
    daxAgreement = await AgreementFactory.deploy(
      treasury.address,
      25,
      await daxCourt.getAddress(),
      treasury.address
    );
    await daxAgreement.waitForDeployment();

    await daxCourt.setAgreementContract(await daxAgreement.getAddress());

    const courtAddr = await daxCourt.getAddress();
    for (const j of [juror1, juror2, juror3]) {
      await daxToken.transfer(j.address, MIN_STAKE * 2n);
      await daxToken.connect(j).approve(courtAddr, MIN_STAKE);
      await daxCourt.connect(j).stake(MIN_STAKE);
    }

    await mockUSDC.transfer(partyA.address, ethers.parseUnits("10000", 6));
  });

  describe("Court Adversarial & Invariant Protections", function () {
    let agreementId, disputeId;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 86400, salt
      );
      const receipt = await tx.wait();
      agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      const disputeTx = await daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH);
      const disputeReceipt = await disputeTx.wait();
      disputeId = disputeReceipt.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised").args.disputeId;

      await daxCourt.initializeTrial(agreementId);
    });

    it("ATTACK: Unassigned caller attempting commitVote MUST REVERT (INV-C01)", async function () {
      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("dummy"));
      await expect(
        daxCourt.connect(attacker).commitVote(disputeId, dummyHash)
      ).to.be.revertedWith("DAX_Court: Caller is not an assigned juror");
    });

    it("ATTACK: Revealing vote with wrong secret MUST REVERT (INV-C03)", async function () {
      const secret = ethers.keccak256(ethers.toUtf8Bytes("secret1"));
      const wrongSecret = ethers.keccak256(ethers.toUtf8Bytes("wrongSecret"));
      const verdict = 1;

      const commitHash = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdict, secret, juror1.address, disputeId]
      ));

      await daxCourt.connect(juror1).commitVote(disputeId, commitHash);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await expect(
        daxCourt.connect(juror1).revealVote(disputeId, verdict, wrongSecret)
      ).to.be.revertedWith("DAX_Court: Commit hash mismatch");
    });

    it("ATTACK: Unstaking during active trial lockup MUST REVERT (INV-C05)", async function () {
      await expect(
        daxCourt.connect(juror1).unstake(MIN_STAKE)
      ).to.be.revertedWith("DAX_Court: Stake locked in active trials");
    });

    it("Should slash losing minority juror 10% upon trial finalization", async function () {
      const secret1 = ethers.keccak256(ethers.toUtf8Bytes("s1"));
      const secret2 = ethers.keccak256(ethers.toUtf8Bytes("s2"));
      const secret3 = ethers.keccak256(ethers.toUtf8Bytes("s3"));

      const verdictBuyer = 1;  // Majority vote
      const verdictSeller = 2; // Minority vote (juror3)

      const commit1 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdictBuyer, secret1, juror1.address, disputeId]));
      const commit2 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdictBuyer, secret2, juror2.address, disputeId]));
      const commit3 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdictSeller, secret3, juror3.address, disputeId]));

      await daxCourt.connect(juror1).commitVote(disputeId, commit1);
      await daxCourt.connect(juror2).commitVote(disputeId, commit2);
      await daxCourt.connect(juror3).commitVote(disputeId, commit3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await daxCourt.connect(juror1).revealVote(disputeId, verdictBuyer, secret1);
      await daxCourt.connect(juror2).revealVote(disputeId, verdictBuyer, secret2);
      await daxCourt.connect(juror3).revealVote(disputeId, verdictSeller, secret3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      const juror3StakeBefore = await daxCourt.jurorStakes(juror3.address);
      await daxCourt.finalizeDispute(disputeId);
      const juror3StakeAfter = await daxCourt.jurorStakes(juror3.address);

      const expectedSlashed = (MIN_STAKE * 1000n) / 10000n; // 10% of 100 DAX = 10 DAX
      expect(juror3StakeBefore - juror3StakeAfter).to.equal(expectedSlashed);
    });
  });
});
