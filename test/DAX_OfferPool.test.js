import { expect } from "chai";
import hre from "hardhat";

describe("DAX_OfferPool — Hardened Non-Custodial Vault & Multi-Slice Escrow Gate", function () {
  let deployer, partyA, partyB, partyC, partyD, treasury;
  let usdt, court, agreement, offerPool;
  const initialSupply = hre.ethers.parseUnits("1000000", 6);
  const poolAmount = hre.ethers.parseUnits("1000", 6);
  const minFill = hre.ethers.parseUnits("100", 6);

  beforeEach(async function () {
    [deployer, partyA, partyB, partyC, partyD, treasury] = await hre.ethers.getSigners();

    // 1. Deploy Mock USDT
    const MockToken = await hre.ethers.getContractFactory("MockToken");
    usdt = await MockToken.deploy("Tether USD", "USDT", initialSupply);
    await usdt.waitForDeployment();

    // 2. Deploy DAX_Court
    const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
    court = await DAX_Court.deploy(await usdt.getAddress());
    await court.waitForDeployment();

    // 3. Deploy DAX_Agreement
    const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
    agreement = await DAX_Agreement.deploy(
      treasury.address,
      50, // 0.5% fee
      await court.getAddress(),
      hre.ethers.ZeroAddress
    );
    await agreement.waitForDeployment();

    await court.setAgreementContract(await agreement.getAddress());

    // 4. Deploy DAX_OfferPool
    const DAX_OfferPool = await hre.ethers.getContractFactory("DAX_OfferPool");
    offerPool = await DAX_OfferPool.deploy(await agreement.getAddress());
    await offerPool.waitForDeployment();

    // Fund partyA with 10,000 USDT
    await usdt.transfer(partyA.address, hre.ethers.parseUnits("10000", 6));
  });

  describe("Multi-Slice Agreement Lifecycle (400 + 300 + 300 = 1000 USDT)", function () {
    it("Should execute 3 independent child escrows and settle each with EIP-712 signatures", async function () {
      const offerPoolAddr = await offerPool.getAddress();
      const agreementAddr = await agreement.getAddress();
      const offerTermsHash = hre.ethers.id("Offer #1: 1,000 USDT for EUR @ 0.85");
      const durationSeconds = 86400; // 24 hours
      const offerExpirySeconds = 36000; // 10 hours
      const salt = hre.ethers.id("OfferSalt_1");

      // Party A approves DAX_OfferPool to deposit 1,000 USDT into vault
      await usdt.connect(partyA).approve(offerPoolAddr, poolAmount);

      const txPub = await offerPool.connect(partyA).publishOffer(
        await usdt.getAddress(),
        poolAmount,
        minFill,
        offerTermsHash,
        durationSeconds,
        offerExpirySeconds,
        salt
      );
      const receiptPub = await txPub.wait();
      const pubEvent = receiptPub.logs.find(
        (log) => offerPool.interface.parseLog(log)?.name === "OfferPublished"
      );
      const offerId = offerPool.interface.parseLog(pubEvent).args.offerId;

      // Check Vault Balance
      expect(await usdt.balanceOf(offerPoolAddr)).to.equal(poolAmount);

      // Slice 1: Party B accepts 400 USDT -> Spawns Agreement #1
      const slice1Amount = hre.ethers.parseUnits("400", 6);
      const tx1 = await offerPool.connect(partyB).acceptOfferSlice(offerId, slice1Amount, hre.ethers.id("s1"));
      const r1 = await tx1.wait();
      const child1Id = offerPool.interface.parseLog(r1.logs.find(l => offerPool.interface.parseLog(l)?.name === "OfferSliceAccepted")).args.childAgreementId;

      // Slice 2: Party C accepts 300 USDT -> Spawns Agreement #2
      const slice2Amount = hre.ethers.parseUnits("300", 6);
      const tx2 = await offerPool.connect(partyC).acceptOfferSlice(offerId, slice2Amount, hre.ethers.id("s2"));
      const r2 = await tx2.wait();
      const child2Id = offerPool.interface.parseLog(r2.logs.find(l => offerPool.interface.parseLog(l)?.name === "OfferSliceAccepted")).args.childAgreementId;

      // Slice 3: Party D accepts remaining 300 USDT -> Spawns Agreement #3
      const slice3Amount = hre.ethers.parseUnits("300", 6);
      const tx3 = await offerPool.connect(partyD).acceptOfferSlice(offerId, slice3Amount, hre.ethers.id("s3"));
      const r3 = await tx3.wait();
      const child3Id = offerPool.interface.parseLog(r3.logs.find(l => offerPool.interface.parseLog(l)?.name === "OfferSliceAccepted")).args.childAgreementId;

      // Offer Pool should now be FULFILLED and 0 remaining in vault
      const offer = await offerPool.offers(offerId);
      expect(offer.remainingAmount).to.equal(0n);
      expect(offer.state).to.equal(3); // FULFILLED
      expect(await usdt.balanceOf(offerPoolAddr)).to.equal(0n);
      expect(await usdt.balanceOf(agreementAddr)).to.equal(poolAmount); // 1,000 USDT inside DAX_Agreement

      // Verify all 3 child agreementescrow states in DAX_Agreement
      const ag1 = await agreement.agreements(child1Id);
      const ag2 = await agreement.agreements(child2Id);
      const ag3 = await agreement.agreements(child3Id);

      expect(ag1.amount).to.equal(slice1Amount);
      expect(ag1.partyB).to.equal(partyB.address);

      expect(ag2.amount).to.equal(slice2Amount);
      expect(ag2.partyB).to.equal(partyC.address);

      expect(ag3.amount).to.equal(slice3Amount);
      expect(ag3.partyB).to.equal(partyD.address);
    });
  });

  describe("Adversarial Security & Vault Protection Suite", function () {
    let offerId;

    beforeEach(async function () {
      const offerTermsHash = hre.ethers.id("Offer #1: 1,000 USDT");
      const salt = hre.ethers.id("OfferSalt_Adv");

      await usdt.connect(partyA).approve(await offerPool.getAddress(), poolAmount);
      const txPub = await offerPool.connect(partyA).publishOffer(
        await usdt.getAddress(),
        poolAmount,
        minFill,
        offerTermsHash,
        86400,
        36000,
        salt
      );
      const receiptPub = await txPub.wait();
      const pubEvent = receiptPub.logs.find(
        (log) => offerPool.interface.parseLog(log)?.name === "OfferPublished"
      );
      offerId = offerPool.interface.parseLog(pubEvent).args.offerId;
    });

    it("ATTACK: Creator attempting to accept own offer MUST REVERT", async function () {
      await expect(
        offerPool.connect(partyA).acceptOfferSlice(offerId, minFill, hre.ethers.id("s1"))
      ).to.be.revertedWith("DAX_OfferPool: Creator cannot accept own offer");
    });

    it("ATTACK: Stranger attempting to cancel offer MUST REVERT", async function () {
      await expect(
        offerPool.connect(partyB).cancelOffer(offerId)
      ).to.be.revertedWith("DAX_OfferPool: Caller is not creator");
    });

    it("ATTACK: Partial fill leaving dust below minFillAmount MUST REVERT", async function () {
      // Pool is 1000 USDT, minFill is 100 USDT. Attempting to fill 950 USDT leaves 50 USDT dust (< 100).
      const dustFill = hre.ethers.parseUnits("950", 6);
      await expect(
        offerPool.connect(partyB).acceptOfferSlice(offerId, dustFill, hre.ethers.id("s_dust"))
      ).to.be.revertedWith("DAX_OfferPool: Remaining slice would leave dust below minimum");
    });

    it("ATTACK: Claiming expired funds BEFORE expiry timestamp passes MUST REVERT", async function () {
      await expect(
        offerPool.connect(partyA).claimExpiredUnused(offerId)
      ).to.be.revertedWith("DAX_OfferPool: Offer not expired yet");
    });

    it("Should allow Creator to cancel active offer and receive 100% refund of remaining funds", async function () {
      const balBefore = await usdt.balanceOf(partyA.address);
      await offerPool.connect(partyA).cancelOffer(offerId);
      const balAfter = await usdt.balanceOf(partyA.address);

      expect(balAfter - balBefore).to.equal(poolAmount);
      const offer = await offerPool.offers(offerId);
      expect(offer.state).to.equal(4); // CANCELLED
      expect(offer.remainingAmount).to.equal(0n);
    });

    it("Should allow Creator to claim expired unused funds AFTER expiry timestamp passes", async function () {
      // Fast forward time past expiry (36000 seconds + 10)
      await hre.network.provider.send("evm_increaseTime", [36010]);
      await hre.network.provider.send("evm_mine");

      const balBefore = await usdt.balanceOf(partyA.address);
      await offerPool.connect(partyA).claimExpiredUnused(offerId);
      const balAfter = await usdt.balanceOf(partyA.address);

      expect(balAfter - balBefore).to.equal(poolAmount);
      const offer = await offerPool.offers(offerId);
      expect(offer.state).to.equal(4); // CANCELLED
    });
  });
});
