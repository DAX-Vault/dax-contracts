import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX_Agreement Universal Protocol Tests", function () {
  let DAX_Agreement, MockToken;
  let daxAgreement, mockUSDC;
  let owner, treasury, court, forwarder, partyA, partyB, stranger;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 6);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Build Freelance Web App"));

  beforeEach(async function () {
    [owner, treasury, court, forwarder, partyA, partyB, stranger] = await ethers.getSigners();

    // Deploy Mock ERC20 (USDC with 6 decimals)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", INITIAL_SUPPLY);
    await mockUSDC.waitForDeployment();

    // Deploy DAX_Agreement contract
    const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
    daxAgreement = await AgreementFactory.deploy(
      treasury.address,
      25, // 0.25% fee (25 BPS)
      court.address,
      forwarder.address
    );
    await daxAgreement.waitForDeployment();

    // Transfer USDC to partyA
    await mockUSDC.transfer(partyA.address, ethers.parseUnits("10000", 6));
  });

  describe("Atomic Creation & Funding", function () {
    it("Should create and fund an ERC-20 agreement in ACTIVE state", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const durationSeconds = 86400 * 14; // 14 days

      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        durationSeconds,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      expect(event).to.not.be.undefined;

      const agreementId = event.args.agreementId;
      const ag = await daxAgreement.agreements(agreementId);

      expect(ag.partyA).to.equal(partyA.address);
      expect(ag.partyB).to.equal(partyB.address);
      expect(ag.amount).to.equal(AGREEMENT_AMOUNT);
      expect(ag.state).to.equal(1); // ACTIVE
    });

    it("Should create and fund a Native ETH agreement", async function () {
      const salt = ethers.randomBytes(32);
      const durationSeconds = 86400 * 14;
      const ethAmount = ethers.parseEther("1.0");

      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        ethers.ZeroAddress,
        ethAmount,
        TERMS_HASH,
        durationSeconds,
        salt,
        { value: ethAmount }
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.amount).to.equal(ethAmount);
      expect(ag.state).to.equal(1); // ACTIVE
    });
  });

  describe("Submit & Release with EIP-712 Signature", function () {
    it("Should release funds to Party B using Party A EIP-712 release signature", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Source code deliverables"));
      const latestBlock = await ethers.provider.getBlock('latest');
      const deadline = latestBlock.timestamp + 86400;
      const nonce = await daxAgreement.nonces(partyA.address);

      // EIP-712 Domain & Types
      const network = await ethers.provider.getNetwork();
      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      const types = {
        BuyerRelease: [
          { name: "agreementId", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const value = {
        agreementId: agreementId,
        evidenceHash: evidenceHash,
        nonce: nonce,
        deadline: deadline
      };

      const buyerSig = await partyA.signTypedData(domain, types, value);

      const initialPartyBBal = await mockUSDC.balanceOf(partyB.address);
      const initialTreasuryBal = await mockUSDC.balanceOf(treasury.address);

      // Execute submitAndRelease
      await daxAgreement.connect(partyB).submitAndRelease(
        agreementId,
        evidenceHash,
        deadline,
        buyerSig
      );

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(2); // SETTLED

      const expectedFee = (AGREEMENT_AMOUNT * 25n) / 10000n; // 0.25% = 1.25 USDC
      const expectedPayout = AGREEMENT_AMOUNT - expectedFee;

      const finalPartyBBal = await mockUSDC.balanceOf(partyB.address);
      const finalTreasuryBal = await mockUSDC.balanceOf(treasury.address);

      expect(finalPartyBBal - initialPartyBBal).to.equal(expectedPayout);
      expect(finalTreasuryBal - initialTreasuryBal).to.equal(expectedFee);
    });
  });

  describe("Instant Mutual Cancellation", function () {
    it("Should refund 100% of escrow to Party A with dual EIP-712 signatures", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const latestBlock = await ethers.provider.getBlock('latest');
      const deadline = latestBlock.timestamp + 86400;
      const nonceA = await daxAgreement.nonces(partyA.address);
      const nonceB = await daxAgreement.nonces(partyB.address);

      const network = await ethers.provider.getNetwork();
      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      const types = {
        MutualCancel: [
          { name: "agreementId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const sigA = await partyA.signTypedData(domain, types, {
        agreementId, nonce: nonceA, deadline
      });

      const sigB = await partyB.signTypedData(domain, types, {
        agreementId, nonce: nonceB, deadline
      });

      const initialPartyABal = await mockUSDC.balanceOf(partyA.address);

      await daxAgreement.mutualCancel(agreementId, deadline, sigA, sigB);

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED

      const finalPartyABal = await mockUSDC.balanceOf(partyA.address);
      expect(finalPartyABal - initialPartyABal).to.equal(AGREEMENT_AMOUNT);
    });
  });

  describe("Dispute Court Escalation", function () {
    it("Should allow court to resolve dispute and split escrow per verdict", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Partial deliverable proof"));
      await daxAgreement.connect(partyB).raiseDispute(agreementId, evidenceHash);

      const agDisputed = await daxAgreement.agreements(agreementId);
      expect(agDisputed.state).to.equal(3); // DISPUTED

      // Court resolves 50% / 50% split
      const partyAAmount = AGREEMENT_AMOUNT / 2n;
      const partyBAmount = AGREEMENT_AMOUNT / 2n;

      await daxAgreement.connect(court).resolveDispute(agreementId, partyAAmount, partyBAmount);

      const agResolved = await daxAgreement.agreements(agreementId);
      expect(agResolved.state).to.equal(4); // RESOLVED
    });
  });
});
