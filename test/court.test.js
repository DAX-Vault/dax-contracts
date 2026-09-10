import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Phase 6: Court V2 Protocol Unit Tests", function () {
  let DAX_Agreement, DAX_Court, MockToken;
  let daxAgreement, daxCourt, daxToken, mockUSDC;
  let owner, treasury, partyA, partyB, juror1, juror2, juror3, platformAuthority, stranger;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
  const MIN_STAKE = ethers.parseUnits("100", 18);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Web Design Agreement"));

  function computeLeaf(agreementId, periodIndex, releaseAmount) {
    const inner = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "uint256"],
        [agreementId, periodIndex, releaseAmount]
      )
    );
    return ethers.keccak256(inner);
  }

  function commutativeKeccak256(a, b) {
    const bufA = Buffer.from(a.slice(2), "hex");
    const bufB = Buffer.from(b.slice(2), "hex");
    return bufA.compare(bufB) < 0
      ? ethers.keccak256(Buffer.concat([bufA, bufB]))
      : ethers.keccak256(Buffer.concat([bufB, bufA]));
  }

  beforeEach(async function () {
    [owner, treasury, partyA, partyB, juror1, juror2, juror3, platformAuthority, stranger] = await ethers.getSigners();

    // Deploy Mock ERC20 DAX Token (18 decimals)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    daxToken = await MockTokenFactory.deploy("DAX Token", "DAX", INITIAL_SUPPLY);
    await daxToken.waitForDeployment();

    // Deploy Mock USDC (6 decimals)
    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseUnits("1000000", 6));
    await mockUSDC.waitForDeployment();

    // Deploy DAX_Court with immutable platformAuthority
    const CourtFactory = await ethers.getContractFactory("DAX_Court");
    daxCourt = await CourtFactory.deploy(await daxToken.getAddress(), platformAuthority.address);
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
      expect(await daxCourt.platformAuthority()).to.equal(platformAuthority.address);
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

      // Party A raises dispute
      const disputeTx = await daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH);
      const disputeReceipt = await disputeTx.wait();
      const event = disputeReceipt.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised");
      disputeId = event.args.disputeId;

      // Initialize Court Trial
      await daxCourt.initializeTrial(agreementId);
    });

    it("Should execute complete Commit -> Reveal -> Finalize trial (BUYER_WINS)", async function () {
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

    it("Should execute complete Commit -> Reveal -> Finalize trial (SELLER_WINS)", async function () {
      const secret1 = ethers.keccak256(ethers.toUtf8Bytes("sec1"));
      const secret2 = ethers.keccak256(ethers.toUtf8Bytes("sec2"));
      const secret3 = ethers.keccak256(ethers.toUtf8Bytes("sec3"));

      const verdictSeller = 2; // SELLER_WINS

      const commit1 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictSeller, secret1, juror1.address, disputeId]
      ));
      const commit2 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictSeller, secret2, juror2.address, disputeId]
      ));
      const commit3 = ethers.keccak256(ethers.solidityPacked(
        ["uint8", "bytes32", "address", "uint256"],
        [verdictSeller, secret3, juror3.address, disputeId]
      ));

      await daxCourt.connect(juror1).commitVote(disputeId, commit1);
      await daxCourt.connect(juror2).commitVote(disputeId, commit2);
      await daxCourt.connect(juror3).commitVote(disputeId, commit3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await daxCourt.connect(juror1).revealVote(disputeId, verdictSeller, secret1);
      await daxCourt.connect(juror2).revealVote(disputeId, verdictSeller, secret2);
      await daxCourt.connect(juror3).revealVote(disputeId, verdictSeller, secret3);

      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      const partyBBalBefore = await mockUSDC.balanceOf(partyB.address);
      const treasuryBalBefore = await mockUSDC.balanceOf(treasury.address);

      await daxCourt.finalizeDispute(disputeId);

      const partyBBalAfter = await mockUSDC.balanceOf(partyB.address);
      const treasuryBalAfter = await mockUSDC.balanceOf(treasury.address);

      const expectedFee = (AGREEMENT_AMOUNT * 25n) / 10000n;
      const expectedPayout = AGREEMENT_AMOUNT - expectedFee;

      expect(partyBBalAfter - partyBBalBefore).to.equal(expectedPayout);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedFee);

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(4); // RESOLVED
    });
  });

  describe("Platform Authority Fallback & Invariants", function () {
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

    it("Should fallback to Platform Authority when reveal deadline passes with quorum < 3", async function () {
      // Warp past both commit and reveal windows without any juror voting (quorum = 0 < 3)
      await ethers.provider.send("evm_increaseTime", [172801]);
      await ethers.provider.send("evm_mine");

      // Regular finalization MUST fail due to quorum < 3
      await expect(
        daxCourt.finalizeDispute(disputeId)
      ).to.be.revertedWith("DAX_Court: Quorum not reached");

      // Non-authority cannot resolve
      await expect(
        daxCourt.connect(stranger).resolveByPlatformAuthority(disputeId, 1)
      ).to.be.revertedWith("DAX_Court: Platform Authority only");

      // Platform authority resolves for Buyer (verdict = 1)
      const partyABalBefore = await mockUSDC.balanceOf(partyA.address);
      await daxCourt.connect(platformAuthority).resolveByPlatformAuthority(disputeId, 1);
      const partyABalAfter = await mockUSDC.balanceOf(partyA.address);

      expect(partyABalAfter - partyABalBefore).to.equal(AGREEMENT_AMOUNT);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(4); // RESOLVED
    });

    it("INVARIANT: Already-released funds can NEVER be touched by Court resolution", async function () {
      const contractAddr = await daxAgreement.getAddress();
      const totalAmount = ethers.parseUnits("300", 6); // 30,000 equivalent
      const trancheAmount = ethers.parseUnits("100", 6); // 10,000 equivalent (Period 0)
      const remainingAmount = ethers.parseUnits("200", 6); // 20,000 equivalent

      await mockUSDC.connect(partyA).approve(contractAddr, totalAmount);
      const salt = ethers.randomBytes(32);
      const network = await ethers.provider.getNetwork();

      const scheduledAgId = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes32", "bytes32", "uint256"],
          [partyA.address, partyB.address, TERMS_HASH, salt, network.chainId]
        )
      );

      const leaf0 = computeLeaf(scheduledAgId, 0, trancheAmount);
      const leaf1 = computeLeaf(scheduledAgId, 1, remainingAmount);
      const scheduleHash = commutativeKeccak256(leaf0, leaf1);

      await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        totalAmount,
        TERMS_HASH,
        scheduleHash,
        2,
        86400 * 14,
        salt
      );

      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      const releaseTypes = {
        BuyerRelease: [
          { name: "agreementId", type: "bytes32" },
          { name: "periodIndex", type: "uint256" },
          { name: "releaseAmount", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;
      const evidence0 = ethers.keccak256(ethers.toUtf8Bytes("Milestone 0 Deliverables"));

      const buyerSig = await partyA.signTypedData(domain, releaseTypes, {
        agreementId: scheduledAgId,
        periodIndex: 0,
        releaseAmount: trancheAmount,
        evidenceHash: evidence0,
        deadline
      });

      // Release Period 0 (Party B receives trancheAmount minus fee)
      const partyBBalBeforeRelease = await mockUSDC.balanceOf(partyB.address);
      await daxAgreement.connect(partyB).submitAndRelease(
        scheduledAgId,
        0,
        trancheAmount,
        evidence0,
        deadline,
        [leaf1],
        buyerSig
      );
      const partyBBalAfterRelease = await mockUSDC.balanceOf(partyB.address);
      const fee0 = (trancheAmount * 25n) / 10000n;
      expect(partyBBalAfterRelease - partyBBalBeforeRelease).to.equal(trancheAmount - fee0);

      // Now Party A raises dispute on remaining escrow
      const dTx = await daxAgreement.connect(partyA).raiseDispute(scheduledAgId, TERMS_HASH);
      const dRec = await dTx.wait();
      const schedDisputeId = dRec.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised").args.disputeId;

      // Initialize Court Trial
      await daxCourt.initializeTrial(scheduledAgId);
      const trial = await daxCourt.trials(schedDisputeId);

      // Verify trial escrowAmount is strictly remainingAmount (200 USDC), not original 300 USDC!
      expect(trial.escrowAmount).to.equal(remainingAmount);

      // Fast forward past reveal window and resolve by Platform Authority for Buyer
      await ethers.provider.send("evm_increaseTime", [172801]);
      await ethers.provider.send("evm_mine");

      const partyABalBeforeCourt = await mockUSDC.balanceOf(partyA.address);
      await daxCourt.connect(platformAuthority).resolveByPlatformAuthority(schedDisputeId, 1);
      const partyABalAfterCourt = await mockUSDC.balanceOf(partyA.address);

      // Buyer receives EXACTLY 200 USDC (the remaining escrow)
      expect(partyABalAfterCourt - partyABalBeforeCourt).to.equal(remainingAmount);

      // Party B's balance from Period 0 was NEVER touched
      const partyBFinalBal = await mockUSDC.balanceOf(partyB.address);
      expect(partyBFinalBal).to.equal(partyBBalAfterRelease);

      // Final agreement state is RESOLVED
      const ag = await daxAgreement.agreements(scheduledAgId);
      expect(ag.state).to.equal(4); // RESOLVED
      expect(ag.releasedAmount).to.equal(trancheAmount);
    });
  });
});
