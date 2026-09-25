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

  // Helper for leaf calculation (frozen standard)
  function computeLeaf(agreementId, periodIndex, releaseAmount) {
    const inner = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "uint256"],
        [agreementId, periodIndex, releaseAmount]
      )
    );
    return ethers.keccak256(inner);
  }

  // Helper for commutative keccak256 (OpenZeppelin MerkleProof standard)
  function commutativeKeccak256(a, b) {
    const bufA = Buffer.from(a.slice(2), "hex");
    const bufB = Buffer.from(b.slice(2), "hex");
    return bufA.compare(bufB) < 0
      ? ethers.keccak256(Buffer.concat([bufA, bufB]))
      : ethers.keccak256(Buffer.concat([bufB, bufA]));
  }

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
        ethers.ZeroHash,
        1,
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
      expect(ag.totalAmount).to.equal(AGREEMENT_AMOUNT);
      expect(ag.releasedAmount).to.equal(0n);
      expect(ag.periodCount).to.equal(1n);
      expect(ag.currentPeriod).to.equal(0n);
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
        ethers.ZeroHash,
        1,
        durationSeconds,
        salt,
        { value: ethAmount }
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.totalAmount).to.equal(ethAmount);
      expect(ag.state).to.equal(1); // ACTIVE
    });

    it("Should create a PENDING agreement on-chain with metadata URI without token transfer, then deposit escrow to activate", async function () {
      const contractAddr = await daxAgreement.getAddress();
      const salt = ethers.randomBytes(32);
      const durationSeconds = 86400 * 14;
      const metadata = JSON.stringify({
        scope: "Full-Stack Web App",
        description: "Build decentralized agreement portal",
        category: "service"
      });

      const partyABalanceBefore = await mockUSDC.balanceOf(partyA.address);

      // 1. Create in PENDING state (zero tokens transferred)
      const createTx = await daxAgreement.connect(partyA).createAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        durationSeconds,
        salt,
        metadata
      );

      const receipt = await createTx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      // Assert tokens were NOT transferred yet
      const partyABalanceAfterCreate = await mockUSDC.balanceOf(partyA.address);
      expect(partyABalanceAfterCreate).to.equal(partyABalanceBefore);

      // Assert on-chain state is PENDING (6)
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(6); // PENDING
      expect(ag.partyA).to.equal(partyA.address);
      expect(ag.partyB).to.equal(partyB.address);
      expect(ag.expiresAt).to.equal(0); // Pending agreement has not started deliverable countdown

      // Assert metadata URI is accessible on-chain
      const storedUri = await daxAgreement.agreementUris(agreementId);
      expect(storedUri).to.equal(metadata);

      // 2. Deposit escrow tokens to activate
      await mockUSDC.connect(partyA).approve(contractAddr, AGREEMENT_AMOUNT);
      const fundTx = await daxAgreement.connect(partyA).depositEscrow(agreementId);
      await fundTx.wait();

      // Assert tokens are now transferred into contract
      const partyABalanceAfterFund = await mockUSDC.balanceOf(partyA.address);
      expect(partyABalanceAfterFund).to.equal(partyABalanceBefore - AGREEMENT_AMOUNT);

      // Assert agreement is now ACTIVE (1) and deliverable countdown starts from escrow deposit
      const agFunded = await daxAgreement.agreements(agreementId);
      expect(agFunded.state).to.equal(1); // ACTIVE
      expect(agFunded.expiresAt).to.equal(agFunded.createdAt + BigInt(durationSeconds));

      // Assert Party A CANNOT cancel after funding (counterparties are now bound)
      await expect(
        daxAgreement.connect(partyA).cancelPendingAgreement(agreementId)
      ).to.be.revertedWith("DAX: Agreement not pending");
    });

    it("Should allow Party A to cancel a PENDING agreement before escrow is deposited", async function () {
      const salt = ethers.randomBytes(32);
      const durationSeconds = 86400 * 14;

      const createTx = await daxAgreement.connect(partyA).createAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        AGREEMENT_AMOUNT,
        TERMS_HASH,
        ethers.ZeroHash,
        1,
        durationSeconds,
        salt,
        ""
      );
      const receipt = await createTx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      await daxAgreement.connect(partyA).cancelPendingAgreement(agreementId);

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED
    });
  });

  describe("Submit & Release with EIP-712 Signature (One-Time Agreement)", function () {
    it("Should release funds to Party B using Party A EIP-712 release signature", async function () {
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
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Source code deliverables"));
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;

      // EIP-712 Domain & Types (Nonce-Free, bound to agreementId + periodIndex + releaseAmount)
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
          { name: "periodIndex", type: "uint256" },
          { name: "releaseAmount", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const value = {
        agreementId: agreementId,
        periodIndex: 0,
        releaseAmount: AGREEMENT_AMOUNT,
        evidenceHash: evidenceHash,
        deadline: deadline
      };

      const buyerSig = await partyA.signTypedData(domain, types, value);

      const initialPartyBBal = await mockUSDC.balanceOf(partyB.address);
      const initialTreasuryBal = await mockUSDC.balanceOf(treasury.address);

      // Execute submitAndRelease for period 0 (empty proof for periodCount = 1)
      await daxAgreement.connect(partyB).submitAndRelease(
        agreementId,
        0,
        AGREEMENT_AMOUNT,
        evidenceHash,
        deadline,
        [],
        buyerSig
      );

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(2); // SETTLED
      expect(ag.releasedAmount).to.equal(AGREEMENT_AMOUNT);
      expect(ag.currentPeriod).to.equal(1n);

      // Verify evidence root mapping
      expect(await daxAgreement.periodEvidenceRoots(agreementId, 0)).to.equal(evidenceHash);

      const expectedFee = (AGREEMENT_AMOUNT * 25n) / 10000n; // 0.25% = 1.25 USDC
      const expectedPayout = AGREEMENT_AMOUNT - expectedFee;

      const finalPartyBBal = await mockUSDC.balanceOf(partyB.address);
      const finalTreasuryBal = await mockUSDC.balanceOf(treasury.address);

      expect(finalPartyBBal - initialPartyBBal).to.equal(expectedPayout);
      expect(finalTreasuryBal - initialTreasuryBal).to.equal(expectedFee);
    });
  });

  describe("Scheduled Agreements (Multi-Period Merkle Tranches)", function () {
    it("Should execute 4-period scheduled release with Merkle proofs and preserve evidence history", async function () {
      const contractAddr = await daxAgreement.getAddress();
      const totalEscrow = ethers.parseUnits("400", 6); // 400 USDC
      const trancheAmount = ethers.parseUnits("100", 6); // 100 USDC per period
      const periodCount = 4;

      await mockUSDC.connect(partyA).approve(contractAddr, totalEscrow);

      const salt = ethers.randomBytes(32);
      const network = await ethers.provider.getNetwork();
      const chainId = network.chainId;

      // Predict agreementId
      const agreementId = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes32", "bytes32", "uint256"],
          [partyA.address, partyB.address, TERMS_HASH, salt, chainId]
        )
      );

      // Compute Merkle leaves for 4 periods
      const leaf0 = computeLeaf(agreementId, 0, trancheAmount);
      const leaf1 = computeLeaf(agreementId, 1, trancheAmount);
      const leaf2 = computeLeaf(agreementId, 2, trancheAmount);
      const leaf3 = computeLeaf(agreementId, 3, trancheAmount);

      const h01 = commutativeKeccak256(leaf0, leaf1);
      const h23 = commutativeKeccak256(leaf2, leaf3);
      const scheduleHash = commutativeKeccak256(h01, h23);

      const proof0 = [leaf1, h23];
      const proof1 = [leaf0, h23];
      const proof2 = [leaf3, h01];
      const proof3 = [leaf2, h01];

      // Create scheduled agreement
      await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        totalEscrow,
        TERMS_HASH,
        scheduleHash,
        periodCount,
        86400 * 30,
        salt
      );

      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: chainId,
        verifyingContract: contractAddr
      };

      const types = {
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

      const proofs = [proof0, proof1, proof2, proof3];

      for (let p = 0; p < periodCount; p++) {
        const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(`Milestone ${p} Evidence`));
        const buyerSig = await partyA.signTypedData(domain, types, {
          agreementId,
          periodIndex: p,
          releaseAmount: trancheAmount,
          evidenceHash,
          deadline
        });

        await daxAgreement.connect(partyB).submitAndRelease(
          agreementId,
          p,
          trancheAmount,
          evidenceHash,
          deadline,
          proofs[p],
          buyerSig
        );

        // Verify milestone evidence is stored and preserved
        expect(await daxAgreement.periodEvidenceRoots(agreementId, p)).to.equal(evidenceHash);

        const ag = await daxAgreement.agreements(agreementId);
        expect(ag.currentPeriod).to.equal(BigInt(p + 1));
        expect(ag.releasedAmount).to.equal(trancheAmount * BigInt(p + 1));

        if (p < periodCount - 1) {
          expect(ag.state).to.equal(1); // ACTIVE
        } else {
          expect(ag.state).to.equal(2); // SETTLED
        }
      }

      // Verify all 4 period evidence roots remain intact (INV-03, evidence history preserved)
      for (let p = 0; p < periodCount; p++) {
        const expected = ethers.keccak256(ethers.toUtf8Bytes(`Milestone ${p} Evidence`));
        expect(await daxAgreement.periodEvidenceRoots(agreementId, p)).to.equal(expected);
      }
    });
  });

  describe("Instant Mutual Cancellation (Nonce-Free)", function () {
    it("Should refund 100% of escrow to Party A with dual EIP-712 signatures", async function () {
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
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;

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
          { name: "deadline", type: "uint256" }
        ]
      };

      const sigA = await partyA.signTypedData(domain, types, { agreementId, deadline });
      const sigB = await partyB.signTypedData(domain, types, { agreementId, deadline });

      const initialPartyABal = await mockUSDC.balanceOf(partyA.address);

      await daxAgreement.mutualCancel(agreementId, deadline, sigA, sigB);

      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED

      const finalPartyABal = await mockUSDC.balanceOf(partyA.address);
      expect(finalPartyABal - initialPartyABal).to.equal(AGREEMENT_AMOUNT);
    });

    it("Should refund only remaining unreleased escrow on mutual cancellation after partial release", async function () {
      const contractAddr = await daxAgreement.getAddress();
      const totalEscrow = ethers.parseUnits("200", 6);
      const trancheAmount = ethers.parseUnits("100", 6);

      await mockUSDC.connect(partyA).approve(contractAddr, totalEscrow);

      const salt = ethers.randomBytes(32);
      const network = await ethers.provider.getNetwork();
      const chainId = network.chainId;

      const agreementId = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes32", "bytes32", "uint256"],
          [partyA.address, partyB.address, TERMS_HASH, salt, chainId]
        )
      );

      const leaf0 = computeLeaf(agreementId, 0, trancheAmount);
      const leaf1 = computeLeaf(agreementId, 1, trancheAmount);
      const scheduleHash = commutativeKeccak256(leaf0, leaf1);

      await daxAgreement.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockUSDC.getAddress(),
        totalEscrow,
        TERMS_HASH,
        scheduleHash,
        2,
        86400 * 14,
        salt
      );

      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId,
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
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Period 0 Evidence"));

      const buyerSig = await partyA.signTypedData(domain, releaseTypes, {
        agreementId,
        periodIndex: 0,
        releaseAmount: trancheAmount,
        evidenceHash,
        deadline
      });

      // Release Period 0
      await daxAgreement.connect(partyB).submitAndRelease(
        agreementId,
        0,
        trancheAmount,
        evidenceHash,
        deadline,
        [leaf1],
        buyerSig
      );

      // Now cancel remaining 100 USDC
      const cancelTypes = {
        MutualCancel: [
          { name: "agreementId", type: "bytes32" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const sigA = await partyA.signTypedData(domain, cancelTypes, { agreementId, deadline });
      const sigB = await partyB.signTypedData(domain, cancelTypes, { agreementId, deadline });

      const balBefore = await mockUSDC.balanceOf(partyA.address);
      await daxAgreement.mutualCancel(agreementId, deadline, sigA, sigB);
      const balAfter = await mockUSDC.balanceOf(partyA.address);

      // Party A receives exactly remaining amount (100 USDC), not original 200 USDC
      expect(balAfter - balBefore).to.equal(trancheAmount);
      const ag = await daxAgreement.agreements(agreementId);
      expect(ag.state).to.equal(5); // REFUNDED
    });
  });

  describe("Dispute Court Escalation", function () {
    it("Should allow court to resolve dispute with disputeId binding", async function () {
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
        86400 * 14,
        salt
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated");
      const agreementId = event.args.agreementId;

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Partial deliverable proof"));
      const disputeTx = await daxAgreement.connect(partyB).raiseDispute(agreementId, evidenceHash);
      const disputeReceipt = await disputeTx.wait();
      const disputeEvent = disputeReceipt.logs.find(l => l.fragment && l.fragment.name === "DisputeRaised");
      const disputeId = disputeEvent.args.disputeId;

      const agDisputed = await daxAgreement.agreements(agreementId);
      expect(agDisputed.state).to.equal(3); // DISPUTED
      expect(agDisputed.disputeId).to.equal(disputeId);

      // Court resolves dispute: Party A gets 100%, Party B gets 0%
      await daxAgreement.connect(court).resolveDispute(agreementId, disputeId, AGREEMENT_AMOUNT, 0);

      const agResolved = await daxAgreement.agreements(agreementId);
      expect(agResolved.state).to.equal(4); // RESOLVED
    });
  });
});
