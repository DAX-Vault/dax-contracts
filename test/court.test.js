import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Phase 6: Court V2 Protocol Unit Tests", function () {
  let DAX_Agreement, DAX_Court, MockToken;
  let daxAgreement, daxCourt, daxToken, mockUSDC;
  let owner, treasury, partyA, partyB, juror1, juror2, juror3, stranger;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
  const MIN_STAKE = ethers.parseUnits("100", 18);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Web Design Agreement"));

  beforeEach(async function () {
    [owner, treasury, partyA, partyB, juror1, juror2, juror3, stranger] = await ethers.getSigners();

    // Deploy Mock ERC20 DAX Token (18 decimals)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    daxToken = await MockTokenFactory.deploy("DAX Token", "DAX", INITIAL_SUPPLY);
    await daxToken.waitForDeployment();

    // Deploy Mock USDC (6 decimals)
    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseUnits("1000000", 6));
    await mockUSDC.waitForDeployment();

    // Deploy DAX_Court
    const CourtFactory = await ethers.getContractFactory("DAX_Court");
    daxCourt = await CourtFactory.deploy(await daxToken.getAddress());
    await daxCourt.waitForDeployment();

    // Deploy DAX_Agreement
    const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
    daxAgreement = await AgreementFactory.deploy(
      treasury.address,
      25, // 0.25% fee
      await daxCourt.getAddress(),
      treasury.address
    );
    await daxAgreement.waitForDeployment();

    // Set agreementContract on DAX_Court
    await daxCourt.setAgreementContract(await daxAgreement.getAddress());

    // Fund jurors with DAX tokens & stake minStake
    const courtAddr = await daxCourt.getAddress();
    for (const j of [juror1, juror2, juror3]) {
      await daxToken.transfer(j.address, MIN_STAKE * 2n);
      await daxToken.connect(j).approve(courtAddr, MIN_STAKE);
      await daxCourt.connect(j).stake(MIN_STAKE);
    }

    // Fund partyA with USDC
    await mockUSDC.transfer(partyA.address, ethers.parseUnits("10000", 6));
  });

  describe("Staking & Registry", function () {
    it("Should allow eligible jurors to stake 100 DAX and register in pool", async function () {
      expect(await daxCourt.jurorStakes(juror1.address)).to.equal(MIN_STAKE);
      expect(await daxCourt.jurorStakes(juror2.address)).to.equal(MIN_STAKE);
      expect(await daxCourt.jurorStakes(juror3.address)).to.equal(MIN_STAKE);
    });

    it("Should prevent unstaking below minStake requirement when active", async function () {
      await expect(
        daxCourt.connect(juror1).unstake(ethers.parseUnits("10", 18))
      ).to.be.revertedWith("DAX_Court: Below minStake requirement");
    });
  });

  describe("Commit-Reveal Dispute Arbitration Lifecycle", function () {
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

      // Party A raises dispute
      const disputeTx = await daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH);
      const disputeReceipt = await disputeTx.wait();
      const event = disputeReceipt.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised");
      disputeId = event.args.disputeId;

      // Initialize Court Trial
      await daxCourt.initializeTrial(agreementId);
    });

    it("Should execute complete Commit ➔ Reveal ➔ Finalize trial (BUYER_WINS)", async function () {
      const secret1 = ethers.keccak256(ethers.toUtf8Bytes("secret1"));
      const secret2 = ethers.keccak256(ethers.toUtf8Bytes("secret2"));
      const secret3 = ethers.keccak256(ethers.toUtf8Bytes("secret3"));

      const verdictBuyer = 1; // BUYER_WINS

      // Commit phase
      const commit1 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictBuyer, secret1, juror1.address, disputeId]
      ));
      const commit2 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictBuyer, secret2, juror2.address, disputeId]
      ));
      const commit3 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictBuyer, secret3, juror3.address, disputeId]
      ));

      await daxCourt.connect(juror1).commitVote(disputeId, commit1);
      await daxCourt.connect(juror2).commitVote(disputeId, commit2);
      await daxCourt.connect(juror3).commitVote(disputeId, commit3);

      // Advance EVM time past commit deadline
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      // Reveal phase
      await daxCourt.connect(juror1).revealVote(disputeId, verdictBuyer, secret1);
      await daxCourt.connect(juror2).revealVote(disputeId, verdictBuyer, secret2);
      await daxCourt.connect(juror3).revealVote(disputeId, verdictBuyer, secret3);

      // Advance EVM time past reveal deadline
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      // Finalize trial
      const partyABalBefore = await mockUSDC.balanceOf(partyA.address);
      await daxCourt.finalizeDispute(disputeId);
      const partyABalAfter = await mockUSDC.balanceOf(partyA.address);

      expect(partyABalAfter - partyABalBefore).to.equal(AGREEMENT_AMOUNT);

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(4); // RESOLVED
    });
  });
});
