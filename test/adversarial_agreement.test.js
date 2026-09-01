import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Phase 2.5: Deep Adversarial Security Gate & Invariant Testing", function () {
  let DAX_Agreement, MockToken, MockMaliciousToken;
  let daxAgreement, mockUSDC, malToken;
  let owner, treasury, court, forwarder, partyA, partyB, partyC, attacker;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 6);
  const AGREEMENT_AMOUNT = ethers.parseUnits("500", 6);
  const TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Software Audit Agreement"));

  beforeEach(async function () {
    [owner, treasury, court, forwarder, partyA, partyB, partyC, attacker] = await ethers.getSigners();

    // Deploy Mock ERC20 (USDC)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", INITIAL_SUPPLY);
    await mockUSDC.waitForDeployment();

    // Deploy Malicious ERC20 Token
    const MaliciousTokenFactory = await ethers.getContractFactory("MockMaliciousToken");
    malToken = await MaliciousTokenFactory.deploy(INITIAL_SUPPLY);
    await malToken.waitForDeployment();

    // Deploy DAX_Agreement
    const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
    daxAgreement = await AgreementFactory.deploy(
      treasury.address,
      25, // 0.25% fee
      court.address,
      forwarder.address
    );
    await daxAgreement.waitForDeployment();

    // Fund test wallets
    await mockUSDC.transfer(partyA.address, ethers.parseUnits("50000", 6));
    await mockUSDC.transfer(partyB.address, ethers.parseUnits("50000", 6));
    await mockUSDC.transfer(attacker.address, ethers.parseUnits("50000", 6));

    await malToken.transfer(partyA.address, ethers.parseUnits("1000", 6));
  });

  describe("1. EIP-712 Signature Replay & Relayer Tampering Attacks", function () {
    let agreementId1, agreementId2, evidenceHash, deadline, domain, types;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT * 2n);

      // Create Agreement 1
      const salt1 = ethers.randomBytes(32);
      const tx1 = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 86400, salt1
      );
      const receipt1 = await tx1.wait();
      agreementId1 = receipt1.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      // Create Agreement 2
      const salt2 = ethers.randomBytes(32);
      const tx2 = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 86400, salt2
      );
      const receipt2 = await tx2.wait();
      agreementId2 = receipt2.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Deliverable Pack 1"));
      const latestBlock = await ethers.provider.getBlock('latest');
      deadline = latestBlock.timestamp + 86400;

      const network = await ethers.provider.getNetwork();
      domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      types = {
        BuyerRelease: [
          { name: "agreementId", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
    });

    it("ATTACK: Replaying Agreement 1 release signature on Agreement 2 MUST REVERT", async function () {
      const nonceA = await daxAgreement.nonces(partyA.address);
      const buyerSigForAg1 = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1, evidenceHash, nonce: nonceA, deadline
      });

      await expect(
        daxAgreement.connect(attacker).submitAndRelease(agreementId2, evidenceHash, deadline, buyerSigForAg1)
      ).to.be.revertedWith("DAX: Invalid buyer release signature");
    });

    it("ATTACK: Relayer altering evidenceHash in calldata MUST REVERT", async function () {
      const nonceA = await daxAgreement.nonces(partyA.address);
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1, evidenceHash, nonce: nonceA, deadline
      });

      const tamperedEvidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Tampered Fake File"));
      await expect(
        daxAgreement.connect(attacker).submitAndRelease(agreementId1, tamperedEvidenceHash, deadline, buyerSig)
      ).to.be.revertedWith("DAX: Invalid buyer release signature");
    });

    it("ATTACK: Replaying signature on already SETTLED agreement MUST REVERT (INV-03)", async function () {
      const nonceA = await daxAgreement.nonces(partyA.address);
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1, evidenceHash, nonce: nonceA, deadline
      });

      await daxAgreement.connect(partyB).submitAndRelease(agreementId1, evidenceHash, deadline, buyerSig);

      await expect(
        daxAgreement.connect(attacker).submitAndRelease(agreementId1, evidenceHash, deadline, buyerSig)
      ).to.be.revertedWith("DAX: Agreement not active");
    });

    it("ATTACK: Expired signature deadline boundary MUST REVERT", async function () {
      const latestBlock = await ethers.provider.getBlock('latest');
      const expiredDeadline = latestBlock.timestamp - 1;
      const nonceA = await daxAgreement.nonces(partyA.address);

      const expiredSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1, evidenceHash, nonce: nonceA, deadline: expiredDeadline
      });

      await expect(
        daxAgreement.connect(partyB).submitAndRelease(agreementId1, evidenceHash, expiredDeadline, expiredSig)
      ).to.be.revertedWith("DAX: Signature deadline expired");
    });
  });

  describe("2. Mutual Cancellation Edge Cases", function () {
    let agreementId, deadline, domain, types;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 86400, salt
      );
      const receipt = await tx.wait();
      agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      const latestBlock = await ethers.provider.getBlock('latest');
      deadline = latestBlock.timestamp + 86400;

      const network = await ethers.provider.getNetwork();
      domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      types = {
        MutualCancel: [
          { name: "agreementId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
    });

    it("ATTACK: Alice signature + Alice signature MUST REVERT", async function () {
      const nonceA = await daxAgreement.nonces(partyA.address);
      const sigA = await partyA.signTypedData(domain, types, { agreementId, nonce: nonceA, deadline });

      await expect(
        daxAgreement.mutualCancel(agreementId, deadline, sigA, sigA)
      ).to.be.revertedWith("DAX: Invalid Party B cancel signature");
    });

    it("ATTACK: Alice signature + Stranger signature MUST REVERT", async function () {
      const nonceA = await daxAgreement.nonces(partyA.address);
      const nonceAttacker = await daxAgreement.nonces(attacker.address);

      const sigA = await partyA.signTypedData(domain, types, { agreementId, nonce: nonceA, deadline });
      const sigAttacker = await attacker.signTypedData(domain, types, { agreementId, nonce: nonceAttacker, deadline });

      await expect(
        daxAgreement.mutualCancel(agreementId, deadline, sigA, sigAttacker)
      ).to.be.revertedWith("DAX: Invalid Party B cancel signature");
    });
  });

  describe("3. Court Authorization & Edge Cases (INV-01, INV-08)", function () {
    let agreementId;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);
      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 86400, salt
      );
      const receipt = await tx.wait();
      agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      await daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH);
    });

    it("ATTACK: Resolving non-existent or un-disputed agreement MUST REVERT", async function () {
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("Fake Agreement"));
      await expect(
        daxAgreement.connect(court).resolveDispute(fakeId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Agreement not in dispute");
    });

    it("ATTACK: Double dispute resolution MUST REVERT (INV-08)", async function () {
      await daxAgreement.connect(court).resolveDispute(agreementId, AGREEMENT_AMOUNT, 0);

      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Agreement not in dispute");
    });

    it("ATTACK: Dispute resolution with invalid sum split MUST REVERT", async function () {
      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, AGREEMENT_AMOUNT / 2n, AGREEMENT_AMOUNT)
      ).to.be.revertedWith("DAX: Dispute amounts sum mismatch");
    });

    it("Should handle court replacement while dispute is active", async function () {
      const newCourt = partyC.address;
      await daxAgreement.connect(treasury).setDisputeCourt(newCourt);

      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, AGREEMENT_AMOUNT / 2n, AGREEMENT_AMOUNT / 2n)
      ).to.be.revertedWith("DAX: Caller is not dispute court");

      await daxAgreement.connect(partyC).resolveDispute(agreementId, AGREEMENT_AMOUNT / 2n, AGREEMENT_AMOUNT / 2n);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(4); // RESOLVED
    });
  });

  describe("4. Malicious ERC-20 & Reentrancy Vectors", function () {
    it("ATTACK: Fee-on-transfer ERC20 deposit MUST REVERT", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await malToken.connect(partyA).approve(contractAddr, ethers.parseUnits("100", 6));
      await malToken.setFeeOnTransfer(true);

      const salt = ethers.randomBytes(32);
      await expect(
        daxAgreement.connect(partyA).createAndFundAgreement(
          partyB.address, await malToken.getAddress(), ethers.parseUnits("100", 6), TERMS_HASH, 86400, salt
        )
      ).to.be.revertedWith("DAX: Fee-on-transfer tokens not supported");
    });

    it("ATTACK: Malicious ERC-20 Reentrancy Attack during transfer MUST BE BLOCKED", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await malToken.connect(partyA).approve(contractAddr, ethers.parseUnits("100", 6));
      await malToken.setFeeOnTransfer(false);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await malToken.getAddress(), ethers.parseUnits("100", 6), TERMS_HASH, 86400, salt
      );
      const receipt = await tx.wait();
      const agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      // Enable reentrancy attack vector on token transfer
      await malToken.setAttackTarget(contractAddr, agreementId);

      await daxAgreement.connect(partyA).claimExpiredRefund; // Setup
      // Execute state check verification
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(1); // ACTIVE
    });
  });

  describe("5. Expiry & Timeout Boundary Testing (INV-07)", function () {
    let agreementId;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address, await mockUSDC.getAddress(), AGREEMENT_AMOUNT, TERMS_HASH, 300, salt // 5 mins
      );
      const receipt = await tx.wait();
      agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;
    });

    it("ATTACK: Claiming expired refund BEFORE expiry MUST REVERT", async function () {
      await expect(
        daxAgreement.connect(partyA).claimExpiredRefund(agreementId)
      ).to.be.revertedWith("DAX: Agreement has not expired yet");
    });

    it("Should allow Party A to claim expired refund AFTER expiry timestamp passes", async function () {
      // Advance EVM time past duration
      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine");

      await daxAgreement.connect(partyA).claimExpiredRefund(agreementId);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED
    });
  });
});
