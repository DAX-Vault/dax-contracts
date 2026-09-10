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
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        86400,
        salt1
      );
      const receipt1 = await tx1.wait();
      agreementId1 = receipt1.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      // Create Agreement 2
      const salt2 = ethers.randomBytes(32);
      const tx2 = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        86400,
        salt2
      );
      const receipt2 = await tx2.wait();
      agreementId2 = receipt2.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Deliverable Pack 1"));
      const latestBlock = await ethers.provider.getBlock("latest");
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
          { name: "periodIndex", type: "uint256" },
          { name: "releaseAmount", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "deadline", type: "uint256" }
        ]
      };
    });

    it("ATTACK: Replaying Agreement 1 release signature on Agreement 2 MUST REVERT", async function () {
      const buyerSigForAg1 = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline
      });

      await expect(
        daxAgreement.connect(attacker).submitAndRelease(
          agreementId2,
          0,
          AGREEMENT_AMOUNT,
          evidenceHash,
          deadline,
          [],
          buyerSigForAg1
        )
      ).to.be.revertedWith("DAX: Invalid buyer release signature");
    });

    it("ATTACK: Relayer altering evidenceHash in calldata MUST REVERT", async function () {
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline
      });

      const tamperedEvidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Tampered Fake File"));
      await expect(
        daxAgreement.connect(attacker).submitAndRelease(
          agreementId1,
          0,
          AGREEMENT_AMOUNT,
          tamperedEvidenceHash,
          deadline,
          [],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Invalid buyer release signature");
    });

    it("ATTACK: Relayer altering releaseAmount in calldata MUST REVERT", async function () {
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline
      });

      const alteredAmount = AGREEMENT_AMOUNT / 2n;
      await expect(
        daxAgreement.connect(attacker).submitAndRelease(
          agreementId1,
          0,
          alteredAmount,
          evidenceHash,
          deadline,
          [],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Single release must equal total amount");
    });

    it("ATTACK: Replaying signature on already SETTLED agreement MUST REVERT (INV-03)", async function () {
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline
      });

      await daxAgreement.connect(partyB).submitAndRelease(
        agreementId1,
        0,
        AGREEMENT_AMOUNT,
        evidenceHash,
        deadline,
        [],
        buyerSig
      );

      await expect(
        daxAgreement.connect(attacker).submitAndRelease(
          agreementId1,
          0,
          AGREEMENT_AMOUNT,
          evidenceHash,
          deadline,
          [],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Agreement not active");
    });

    it("ATTACK: Expired signature deadline boundary MUST REVERT", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const expiredDeadline = latestBlock.timestamp - 1;

      const expiredSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline: expiredDeadline
      });

      await expect(
        daxAgreement.connect(partyB).submitAndRelease(
          agreementId1,
          0,
          AGREEMENT_AMOUNT,
          evidenceHash,
          expiredDeadline,
          [],
          expiredSig
        )
      ).to.be.revertedWith("DAX: Signature deadline expired");
    });

    it("ATTACK: Releasing after agreement expiresAt passes MUST REVERT", async function () {
      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId: agreementId1,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash,
        deadline
      });

      // Warp EVM time past agreement expiry (86400s)
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");

      await expect(
        daxAgreement.connect(partyB).submitAndRelease(
          agreementId1,
          0,
          AGREEMENT_AMOUNT,
          evidenceHash,
          deadline,
          [],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Agreement expired");
    });
  });

  describe("2. Scheduled Agreement Invariants & Merkle Proof Attacks", function () {
    let agreementId, trancheAmount, totalAmount, leaf0, leaf1, scheduleHash, domain, types;

    beforeEach(async function () {
      const contractAddr = await daxAgreement.getAddress();
      totalAmount = ethers.parseUnits("200", 6);
      trancheAmount = ethers.parseUnits("100", 6);

      await mockUSDC.connect(partyA).approve(contractAddr, totalAmount);
      const salt = ethers.randomBytes(32);
      const network = await ethers.provider.getNetwork();

      agreementId = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes32", "bytes32", "uint256"],
          [partyA.address, partyB.address, TERMS_HASH, salt, network.chainId]
        )
      );

      leaf0 = computeLeaf(agreementId, 0, trancheAmount);
      leaf1 = computeLeaf(agreementId, 1, trancheAmount);
      scheduleHash = commutativeKeccak256(leaf0, leaf1);

      await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        totalAmount,
        TERMS_HASH,
        scheduleHash,
        2,
        86400 * 10,
        salt
      );

      domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: contractAddr
      };

      types = {
        BuyerRelease: [
          { name: "agreementId", type: "bytes32" },
          { name: "periodIndex", type: "uint256" },
          { name: "releaseAmount", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "deadline", type: "uint256" }
        ]
      };
    });

    it("ATTACK: Submitting invalid Merkle proof MUST REVERT", async function () {
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence 0"));
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;

      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId,
        periodIndex: 0,
        releaseAmount: trancheAmount,
        evidenceHash,
        deadline
      });

      const fakeProof = [ethers.randomBytes(32)];
      await expect(
        daxAgreement.connect(partyB).submitAndRelease(
          agreementId,
          0,
          trancheAmount,
          evidenceHash,
          deadline,
          fakeProof,
          buyerSig
        )
      ).to.be.revertedWith("DAX: Invalid schedule proof");
    });

    it("ATTACK: Skipping period (e.g. submitting period 1 before period 0) MUST REVERT", async function () {
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence 1"));
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;

      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId,
        periodIndex: 1,
        releaseAmount: trancheAmount,
        evidenceHash,
        deadline
      });

      await expect(
        daxAgreement.connect(partyB).submitAndRelease(
          agreementId,
          1,
          trancheAmount,
          evidenceHash,
          deadline,
          [leaf0],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Period out of sequence");
    });

    it("ATTACK: Attempting to release altered tranche amount with original proof MUST REVERT", async function () {
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence 0"));
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;
      const inflatedAmount = trancheAmount * 2n;

      const buyerSig = await partyA.signTypedData(domain, types, {
        agreementId,
        periodIndex: 0,
        releaseAmount: inflatedAmount,
        evidenceHash,
        deadline
      });

      await expect(
        daxAgreement.connect(partyB).submitAndRelease(
          agreementId,
          0,
          inflatedAmount,
          evidenceHash,
          deadline,
          [leaf1],
          buyerSig
        )
      ).to.be.revertedWith("DAX: Invalid schedule proof");
    });
  });

  describe("3. Mutual Cancellation Edge Cases (Nonce-Free)", function () {
    let agreementId, deadline, domain, types;

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

      const latestBlock = await ethers.provider.getBlock("latest");
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
          { name: "deadline", type: "uint256" }
        ]
      };
    });

    it("ATTACK: Alice signature + Alice signature MUST REVERT", async function () {
      const sigA = await partyA.signTypedData(domain, types, { agreementId, deadline });

      await expect(
        daxAgreement.mutualCancel(agreementId, deadline, sigA, sigA)
      ).to.be.revertedWith("DAX: Invalid Party B cancel signature");
    });

    it("ATTACK: Alice signature + Stranger signature MUST REVERT", async function () {
      const sigA = await partyA.signTypedData(domain, types, { agreementId, deadline });
      const sigAttacker = await attacker.signTypedData(domain, types, { agreementId, deadline });

      await expect(
        daxAgreement.mutualCancel(agreementId, deadline, sigA, sigAttacker)
      ).to.be.revertedWith("DAX: Invalid Party B cancel signature");
    });

    it("ATTACK: Replaying mutual cancellation on already REFUNDED agreement MUST REVERT", async function () {
      const sigA = await partyA.signTypedData(domain, types, { agreementId, deadline });
      const sigB = await partyB.signTypedData(domain, types, { agreementId, deadline });

      await daxAgreement.mutualCancel(agreementId, deadline, sigA, sigB);

      await expect(
        daxAgreement.mutualCancel(agreementId, deadline, sigA, sigB)
      ).to.be.revertedWith("DAX: Agreement not active");
    });
  });

  describe("4. Court Authorization & Edge Cases (INV-01, INV-08)", function () {
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
    });

    it("ATTACK: Resolving non-existent or un-disputed agreement MUST REVERT", async function () {
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("Fake Agreement"));
      await expect(
        daxAgreement.connect(court).resolveDispute(fakeId, disputeId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Agreement not in dispute");
    });

    it("ATTACK: Resolving dispute with wrong disputeId MUST REVERT", async function () {
      const wrongDisputeId = 999999;
      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, wrongDisputeId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Dispute ID mismatch");
    });

    it("ATTACK: Double dispute resolution MUST REVERT (INV-08)", async function () {
      await daxAgreement.connect(court).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT, 0);

      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Agreement not in dispute");
    });

    it("ATTACK: Dispute resolution with invalid sum split MUST REVERT", async function () {
      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT / 2n, AGREEMENT_AMOUNT)
      ).to.be.revertedWith("DAX: Dispute amounts sum mismatch");
    });

    it("Should handle court replacement while dispute is active", async function () {
      const newCourt = partyC.address;
      await daxAgreement.connect(treasury).setDisputeCourt(newCourt);

      await expect(
        daxAgreement.connect(court).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT, 0)
      ).to.be.revertedWith("DAX: Caller is not dispute court");

      await daxAgreement.connect(partyC).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT, 0);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(4); // RESOLVED
    });
  });

  describe("5. Malicious ERC-20 & Reentrancy Vectors", function () {
    it("ATTACK: Fee-on-transfer ERC20 deposit MUST REVERT", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await malToken.connect(partyA).approve(contractAddr, ethers.parseUnits("100", 6));
      await malToken.setFeeOnTransfer(true);

      const salt = ethers.randomBytes(32);
      await expect(
        daxAgreement.connect(partyA).createAndFundAgreement(
          partyB.address,
          await malToken.getAddress(),
          ethers.parseUnits("100", 6),
          TERMS_HASH,
          ethers.ZeroHash,
          1,
          86400,
          salt
        )
      ).to.be.revertedWith("DAX: Fee-on-transfer tokens not supported");
    });

    it("ATTACK: Malicious ERC-20 Reentrancy Attack during transfer MUST BE BLOCKED", async function () {
      const contractAddr = await daxAgreement.getAddress();
      await malToken.connect(partyA).approve(contractAddr, ethers.parseUnits("100", 6));
      await malToken.setFeeOnTransfer(false);

      const salt = ethers.randomBytes(32);
      const tx = await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await malToken.getAddress(),
        ethers.parseUnits("100", 6),
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        86400,
        salt
      );
      const receipt = await tx.wait();
      const agreementId = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;

      await malToken.setAttackTarget(contractAddr, agreementId);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(1); // ACTIVE
    });
  });

  describe("6. Expiry & Timeout Boundary Testing (INV-07)", function () {
    let agreementId;

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
        300, // 5 mins
        salt
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
      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine");

      await daxAgreement.connect(partyA).claimExpiredRefund(agreementId);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED
    });

    it("ATTACK: Raising dispute AFTER expiry timestamp passes MUST REVERT", async function () {
      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine");

      await expect(
        daxAgreement.connect(partyA).raiseDispute(agreementId, TERMS_HASH)
      ).to.be.revertedWith("DAX: Agreement expired");
    });
  });
});
