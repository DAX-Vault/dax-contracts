import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Phase 6.5: Court Adversarial Security & Fuzzing Gate", function () {
  let DAX_Agreement, DAX_Court, MockToken;
  let daxAgreement, daxCourt, daxToken, mockUSDC;
  let owner, treasury, partyA, partyB, juror1, juror2, juror3, platformAuthority, attacker;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
  const MIN_STAKE = ethers.parseUnits("100", 18);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Fuzz Audit Contract"));

  beforeEach(async function () {
    [owner, treasury, partyA, partyB, juror1, juror2, juror3, platformAuthority, attacker] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    daxToken = await MockTokenFactory.deploy("DAX Token", "DAX", INITIAL_SUPPLY);
    await daxToken.waitForDeployment();

    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseUnits("1000000", 6));
    await mockUSDC.waitForDeployment();

    const CourtFactory = await ethers.getContractFactory("DAX_Court");
    daxCourt = await CourtFactory.deploy(await daxToken.getAddress(), platformAuthority.address);
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

  describe("1. Ghosting Juror Penalties & Fallback Timeouts", function () {
    let agreementId, disputeId;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        86400,
        salt
      );
      const receipt = await tx.wait();
      agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      const disputeTx = await daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH);
      const disputeReceipt = await disputeTx.wait();
      disputeId = disputeReceipt.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised").args.disputeId;

      await daxCourt.initializeTrial(agreementId);
    });

    it("ATTACK: Finalizing trial before reveal deadline MUST REVERT", async function () {
      await expect(
        daxCourt.finalizeDispute(disputeId)
      ).to.be.revertedWith("DAX_Court: Reveal window still open");
    });

    it("Ghosting Juror (commits but fails to reveal) receives 20% slashing penalty on fallback", async function () {
      const secret1 = ethers.keccak256(ethers.toUtf8Bytes("s1"));
      const secret2 = ethers.keccak256(ethers.toUtf8Bytes("s2"));
      const secret3 = ethers.keccak256(ethers.toUtf8Bytes("s3"));

      const verdict = 1; // BUYER_WINS

      const commit1 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret1, juror1.address, disputeId]));
      const commit2 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret2, juror2.address, disputeId]));
      const commit3 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret3, juror3.address, disputeId]));

      await daxCourt.connect(juror1).commitVote(disputeId, commit1);
      await daxCourt.connect(juror2).commitVote(disputeId, commit2);
      await daxCourt.connect(juror3).commitVote(disputeId, commit3); // Juror 3 commits but ghosts reveal

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      // Only Juror 1 and 2 reveal
      await daxCourt.connect(juror1).revealVote(disputeId, verdict, secret1);
      await daxCourt.connect(juror2).revealVote(disputeId, verdict, secret2);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      // Regular finalizeDispute MUST fail because quorum < 3 (only 2 revealed)
      await expect(
        daxCourt.finalizeDispute(disputeId)
      ).to.be.revertedWith("DAX_Court: Quorum not reached");

      const juror3StakeBefore = await daxCourt.jurorStakes(juror3.address);

      // Platform authority resolves after quorum failure
      await daxCourt.connect(platformAuthority).resolveByPlatformAuthority(disputeId, verdict);

      const juror3StakeAfter = await daxCourt.jurorStakes(juror3.address);

      // Ghosting penalty = 20% of 100 DAX = 20 DAX
      const expectedGhostSlash = (MIN_STAKE * 2000n) / 10000n;
      expect(juror3StakeBefore - juror3StakeAfter).to.equal(expectedGhostSlash);
    });

    it("ATTACK: Double finalization of dispute MUST REVERT", async function () {
      const secret1 = ethers.keccak256(ethers.toUtf8Bytes("s1"));
      const secret2 = ethers.keccak256(ethers.toUtf8Bytes("s2"));
      const secret3 = ethers.keccak256(ethers.toUtf8Bytes("s3"));
      const verdict = 1;

      const commit1 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret1, juror1.address, disputeId]));
      const commit2 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret2, juror2.address, disputeId]));
      const commit3 = ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "address", "uint256"], [verdict, secret3, juror3.address, disputeId]));

      await daxCourt.connect(juror1).commitVote(disputeId, commit1);
      await daxCourt.connect(juror2).commitVote(disputeId, commit2);
      await daxCourt.connect(juror3).commitVote(disputeId, commit3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await daxCourt.connect(juror1).revealVote(disputeId, verdict, secret1);
      await daxCourt.connect(juror2).revealVote(disputeId, verdict, secret2);
      await daxCourt.connect(juror3).revealVote(disputeId, verdict, secret3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await daxCourt.finalizeDispute(disputeId);

      await expect(
        daxCourt.finalizeDispute(disputeId)
      ).to.be.revertedWith("DAX_Court: Invalid trial state");
    });
  });
});
