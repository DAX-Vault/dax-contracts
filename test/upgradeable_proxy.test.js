import { expect } from "chai";
import hre from "hardhat";

const { ethers, upgrades } = hre;

describe("DAX Protocol UUPS Upgradeable Architecture", function () {
  let deployer;
  let owner;
  let partyA;
  let partyB;
  let treasury;
  let platformAuthority;
  let untrusted;

  let agreementProxy;
  let offerPoolProxy;
  let courtProxy;
  let daxToken;
  let mockERC20;

  const ZERO_ADDRESS = ethers.ZeroAddress;
  const TREASURY_FEE_BPS = 50n; // 0.5%
  const SAMPLE_TERMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("Test Terms V1"));
  const SAMPLE_SCHEDULE_HASH = ethers.keccak256(ethers.toUtf8Bytes("Test Schedule V1"));
  const PERIOD_COUNT = 1n;
  const DURATION_SECONDS = 86400n; // 1 day
  const SALT = ethers.randomBytes(32);

  beforeEach(async function () {
    [deployer, owner, partyA, partyB, treasury, platformAuthority, untrusted] =
      await ethers.getSigners();

    // 1. Deploy DAX Token
    const DAX_Token = await ethers.getContractFactory("DAX_Token");
    daxToken = await DAX_Token.deploy(owner.address);
    await daxToken.waitForDeployment();

    // 2. Deploy Mock Token for Escrow testing
    const MockToken = await ethers.getContractFactory("MockToken");
    mockERC20 = await MockToken.deploy("Test USD", "TUSD", ethers.parseEther("1000000"));
    await mockERC20.waitForDeployment();
    await mockERC20.mint(partyA.address, ethers.parseEther("10000"));

    // 3. Deploy DAX_AgreementUpgradeable Proxy
    const DAX_AgreementUpgradeable = await ethers.getContractFactory("DAX_AgreementUpgradeable");
    agreementProxy = await upgrades.deployProxy(
      DAX_AgreementUpgradeable,
      [treasury.address, TREASURY_FEE_BPS, platformAuthority.address, owner.address],
      {
        kind: "uups",
        constructorArgs: [ZERO_ADDRESS], // trustedForwarder = address(0)
      }
    );
    await agreementProxy.waitForDeployment();

    // 4. Deploy DAX_OfferPoolUpgradeable Proxy
    const DAX_OfferPoolUpgradeable = await ethers.getContractFactory("DAX_OfferPoolUpgradeable");
    offerPoolProxy = await upgrades.deployProxy(
      DAX_OfferPoolUpgradeable,
      [await agreementProxy.getAddress(), owner.address],
      { kind: "uups" }
    );
    await offerPoolProxy.waitForDeployment();

    // 5. Deploy DAX_CourtUpgradeable Proxy
    const DAX_CourtUpgradeable = await ethers.getContractFactory("DAX_CourtUpgradeable");
    courtProxy = await upgrades.deployProxy(
      DAX_CourtUpgradeable,
      [await daxToken.getAddress(), platformAuthority.address, await agreementProxy.getAddress(), owner.address],
      { kind: "uups" }
    );
    await courtProxy.waitForDeployment();

    // Link court to agreement
    await agreementProxy.connect(owner).setDisputeCourt(await courtProxy.getAddress());
  });

  describe("Proxy Initialization & Access Control", function () {
    it("initializes DAX_Agreement proxy with correct state and owner", async function () {
      expect(await agreementProxy.owner()).to.equal(owner.address);
      expect(await agreementProxy.treasury()).to.equal(treasury.address);
      expect(await agreementProxy.treasuryFeeBps()).to.equal(TREASURY_FEE_BPS);
      expect(await agreementProxy.disputeCourt()).to.equal(await courtProxy.getAddress());
    });

    it("prevents re-initialization of proxy contracts", async function () {
      await expect(
        agreementProxy.initialize(treasury.address, 100n, courtProxy.getAddress(), owner.address)
      ).to.be.revertedWithCustomError(agreementProxy, "InvalidInitialization");

      await expect(
        offerPoolProxy.initialize(await agreementProxy.getAddress(), owner.address)
      ).to.be.revertedWithCustomError(offerPoolProxy, "InvalidInitialization");

      await expect(
        courtProxy.initialize(await daxToken.getAddress(), platformAuthority.address, await agreementProxy.getAddress(), owner.address)
      ).to.be.revertedWithCustomError(courtProxy, "InvalidInitialization");
    });

    it("restricts upgrade authorization (_authorizeUpgrade) exclusively to owner", async function () {
      const DAX_AgreementV2Mock = await ethers.getContractFactory("DAX_AgreementV2Mock");
      
      // Untrusted account attempts upgrade
      await expect(
        upgrades.upgradeProxy(await agreementProxy.getAddress(), DAX_AgreementV2Mock.connect(untrusted), {
          constructorArgs: [ZERO_ADDRESS],
        })
      ).to.be.revertedWithCustomError(agreementProxy, "OwnableUnauthorizedAccount");
    });
  });

  describe("Zero-Downtime State & Escrow Preservation Across Upgrades", function () {
    it("preserves active agreements and escrow balances without loss during V1 -> V2 upgrade", async function () {
      const escrowAmount = ethers.parseEther("1.5"); // 1.5 ETH
      const initialProxyAddress = await agreementProxy.getAddress();

      // Step 1: Party A creates and funds an agreement on V1 proxy
      const tx = await agreementProxy.connect(partyA).createAndFundAgreement(
        partyB.address,
        ZERO_ADDRESS, // Native ETH
        escrowAmount,
        SAMPLE_TERMS_HASH,
        SAMPLE_SCHEDULE_HASH,
        PERIOD_COUNT,
        DURATION_SECONDS,
        SALT,
        { value: escrowAmount }
      );
      const receipt = await tx.wait();

      // Extract agreementId from AgreementCreated event
      const createdEvent = receipt.logs
        .map((log) => {
          try {
            return agreementProxy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "AgreementCreated");

      expect(createdEvent).to.not.be.null;
      const agreementId = createdEvent.args[0];

      // Verify V1 state
      const preAg = await agreementProxy.agreements(agreementId);
      expect(preAg.partyA).to.equal(partyA.address);
      expect(preAg.partyB).to.equal(partyB.address);
      expect(preAg.totalAmount).to.equal(escrowAmount);
      expect(preAg.state).to.equal(1n); // ACTIVE

      // Check contract holds the escrow ETH
      const preBalance = await ethers.provider.getBalance(initialProxyAddress);
      expect(preBalance).to.equal(escrowAmount);

      // Step 2: Protocol Upgrade to V2 by Owner
      const DAX_AgreementV2Mock = await ethers.getContractFactory("DAX_AgreementV2Mock");
      const upgradedProxy = await upgrades.upgradeProxy(
        initialProxyAddress,
        DAX_AgreementV2Mock.connect(owner),
        { constructorArgs: [ZERO_ADDRESS] }
      );
      await upgradedProxy.waitForDeployment();

      const postProxyAddress = await upgradedProxy.getAddress();

      // INVARIANT 1: Proxy address MUST remain identical
      expect(postProxyAddress).to.equal(initialProxyAddress);

      // INVARIANT 2: Entire Escrow balance remains locked inside the proxy (zero loss)
      const postBalance = await ethers.provider.getBalance(postProxyAddress);
      expect(postBalance).to.equal(escrowAmount);

      // INVARIANT 3: Agreement state is 100% intact
      const postAg = await upgradedProxy.agreements(agreementId);
      expect(postAg.partyA).to.equal(partyA.address);
      expect(postAg.partyB).to.equal(partyB.address);
      expect(postAg.totalAmount).to.equal(escrowAmount);
      expect(postAg.state).to.equal(1n); // STILL ACTIVE

      // INVARIANT 4: New V2 logic is immediately active
      expect(await upgradedProxy.protocolVersion()).to.equal("2.0.0-UUPS");

      // INVARIANT 5: Post-upgrade operations function seamlessly (release escrow via EIP-712 signature)
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence V2 Deliverable"));
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + 86400;

      const network = await ethers.provider.getNetwork();
      const domain = {
        name: "DAX Agreement Protocol",
        version: "1.0.0",
        chainId: network.chainId,
        verifyingContract: postProxyAddress,
      };

      const types = {
        BuyerRelease: [
          { name: "agreementId", type: "bytes32" },
          { name: "periodIndex", type: "uint256" },
          { name: "releaseAmount", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        agreementId: agreementId,
        periodIndex: 0,
        releaseAmount: escrowAmount,
        evidenceHash: evidenceHash,
        deadline: deadline,
      };

      const buyerSig = await partyA.signTypedData(domain, types, value);

      const partyBPreBalance = await ethers.provider.getBalance(partyB.address);
      await upgradedProxy.submitAndRelease(
        agreementId,
        0,
        escrowAmount,
        evidenceHash,
        deadline,
        buyerSig,
        []
      );

      const finalAg = await upgradedProxy.agreements(agreementId);
      expect(finalAg.state).to.equal(2n); // SETTLED

      const partyBPostBalance = await ethers.provider.getBalance(partyB.address);
      const expectedFee = (escrowAmount * TREASURY_FEE_BPS) / 10000n;
      const expectedPayout = escrowAmount - expectedFee;
      expect(partyBPostBalance - partyBPreBalance).to.equal(expectedPayout);
    });

    it("preserves ERC-20 token escrow across UUPS upgrades", async function () {
      const tokenEscrow = ethers.parseEther("500");
      const initialProxyAddress = await agreementProxy.getAddress();

      // Approve and create agreement with ERC20
      await mockERC20.connect(partyA).approve(initialProxyAddress, tokenEscrow);
      const tx = await agreementProxy.connect(partyA).createAndFundAgreement(
        partyB.address,
        await mockERC20.getAddress(),
        tokenEscrow,
        SAMPLE_TERMS_HASH,
        SAMPLE_SCHEDULE_HASH,
        PERIOD_COUNT,
        DURATION_SECONDS,
        ethers.randomBytes(32)
      );
      const receipt = await tx.wait();

      const createdEvent = receipt.logs
        .map((log) => {
          try {
            return agreementProxy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "AgreementCreated");

      const agreementId = createdEvent.args[0];

      // Contract holds ERC20 tokens
      expect(await mockERC20.balanceOf(initialProxyAddress)).to.equal(tokenEscrow);

      // Perform upgrade
      const DAX_AgreementV2Mock = await ethers.getContractFactory("DAX_AgreementV2Mock");
      const upgraded = await upgrades.upgradeProxy(
        initialProxyAddress,
        DAX_AgreementV2Mock.connect(owner),
        { constructorArgs: [ZERO_ADDRESS] }
      );

      // Token balance is untouched in proxy
      expect(await mockERC20.balanceOf(await upgraded.getAddress())).to.equal(tokenEscrow);

      // Can claim expired refund under V2
      await ethers.provider.send("evm_increaseTime", [Number(DURATION_SECONDS) + 10]);
      await ethers.provider.send("evm_mine");

      await upgraded.connect(partyA).claimExpiredRefund(agreementId);
      const agAfterCancel = await upgraded.agreements(agreementId);
      expect(agAfterCancel.state).to.equal(5n); // REFUNDED
      expect(await mockERC20.balanceOf(partyA.address)).to.equal(ethers.parseEther("10000"));
    });
  });

  describe("DAX_OfferPoolUpgradeable Integrity", function () {
    it("publishes offer and keeps state consistent across pool operations", async function () {
      const poolAmount = ethers.parseEther("500");
      const minFill = ethers.parseEther("100");
      const offerExpirySeconds = 3600n; // 1 hour

      await mockERC20.connect(partyA).approve(await offerPoolProxy.getAddress(), poolAmount);
      const tx = await offerPoolProxy.connect(partyA).publishOffer(
        await mockERC20.getAddress(),
        poolAmount,
        minFill,
        SAMPLE_TERMS_HASH,
        DURATION_SECONDS,
        offerExpirySeconds,
        ethers.randomBytes(32)
      );
      const receipt = await tx.wait();

      const createdEvent = receipt.logs
        .map((log) => {
          try {
            return offerPoolProxy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "OfferPublished");

      expect(createdEvent).to.not.be.null;
      const offerId = createdEvent.args[0];

      const offer = await offerPoolProxy.offers(offerId);
      expect(offer.creator).to.equal(partyA.address);
      expect(offer.totalAmount).to.equal(poolAmount);
      expect(offer.remainingAmount).to.equal(poolAmount);
      expect(offer.state).to.equal(1n); // OPEN

      // Creator can cancel and receive full refund
      const preBalance = await mockERC20.balanceOf(partyA.address);
      await offerPoolProxy.connect(partyA).cancelOffer(offerId);
      const postBalance = await mockERC20.balanceOf(partyA.address);
      expect(postBalance - preBalance).to.equal(poolAmount);
    });

    it("preserves published offers and balances across OfferPool UUPS upgrades", async function () {
      const poolAmount = ethers.parseEther("800");
      const minFill = ethers.parseEther("200");
      const offerExpirySeconds = 3600n;
      const initialProxyAddress = await offerPoolProxy.getAddress();

      await mockERC20.connect(partyA).approve(initialProxyAddress, poolAmount);
      const tx = await offerPoolProxy.connect(partyA).publishOffer(
        await mockERC20.getAddress(),
        poolAmount,
        minFill,
        SAMPLE_TERMS_HASH,
        DURATION_SECONDS,
        offerExpirySeconds,
        ethers.randomBytes(32)
      );
      const receipt = await tx.wait();
      const createdEvent = receipt.logs
        .map((log) => {
          try {
            return offerPoolProxy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "OfferPublished");

      const offerId = createdEvent.args[0];

      // Upgrade OfferPool to V2
      const DAX_OfferPoolV2Mock = await ethers.getContractFactory("DAX_OfferPoolV2Mock");
      
      // Untrusted account cannot upgrade
      await expect(
        upgrades.upgradeProxy(initialProxyAddress, DAX_OfferPoolV2Mock.connect(untrusted))
      ).to.be.revertedWithCustomError(offerPoolProxy, "OwnableUnauthorizedAccount");

      // Owner upgrades successfully
      const upgradedOfferPool = await upgrades.upgradeProxy(
        initialProxyAddress,
        DAX_OfferPoolV2Mock.connect(owner)
      );
      await upgradedOfferPool.waitForDeployment();

      // INVARIANT: Address identical
      expect(await upgradedOfferPool.getAddress()).to.equal(initialProxyAddress);
      expect(await upgradedOfferPool.poolVersion()).to.equal("2.0.0-UUPS");

      // INVARIANT: Offer and remaining amount intact
      const offerPost = await upgradedOfferPool.offers(offerId);
      expect(offerPost.creator).to.equal(partyA.address);
      expect(offerPost.totalAmount).to.equal(poolAmount);
      expect(offerPost.remainingAmount).to.equal(poolAmount);
      expect(offerPost.state).to.equal(1n);

      // INVARIANT: Post-upgrade cancellation returns 100% of tokens
      const preCancelBal = await mockERC20.balanceOf(partyA.address);
      await upgradedOfferPool.connect(partyA).cancelOffer(offerId);
      const postCancelBal = await mockERC20.balanceOf(partyA.address);
      expect(postCancelBal - preCancelBal).to.equal(poolAmount);
    });
  });

  describe("DAX_CourtUpgradeable Integrity & Upgrade Verification", function () {
    it("preserves juror stakes across Court UUPS upgrades", async function () {
      const stakeAmount = ethers.parseEther("500");
      const initialCourtAddress = await courtProxy.getAddress();

      // Transfer DAX tokens to partyA and stake as Juror
      await daxToken.connect(owner).transfer(partyA.address, stakeAmount);
      await daxToken.connect(partyA).approve(initialCourtAddress, stakeAmount);
      await courtProxy.connect(partyA).stake(stakeAmount);

      expect(await courtProxy.jurorStakes(partyA.address)).to.equal(stakeAmount);

      // Upgrade Court to V2
      const DAX_CourtV2Mock = await ethers.getContractFactory("DAX_CourtV2Mock");

      // Untrusted account cannot upgrade
      await expect(
        upgrades.upgradeProxy(initialCourtAddress, DAX_CourtV2Mock.connect(untrusted))
      ).to.be.revertedWithCustomError(courtProxy, "OwnableUnauthorizedAccount");

      // Owner upgrades successfully
      const upgradedCourt = await upgrades.upgradeProxy(
        initialCourtAddress,
        DAX_CourtV2Mock.connect(owner)
      );
      await upgradedCourt.waitForDeployment();

      // INVARIANT: Address identical
      expect(await upgradedCourt.getAddress()).to.equal(initialCourtAddress);
      expect(await upgradedCourt.courtVersion()).to.equal("2.0.0-UUPS");

      // INVARIANT: Juror stake intact
      expect(await upgradedCourt.jurorStakes(partyA.address)).to.equal(stakeAmount);

      // Juror can unstake post-upgrade
      await upgradedCourt.connect(partyA).unstake(stakeAmount);
      expect(await upgradedCourt.jurorStakes(partyA.address)).to.equal(0n);
      expect(await daxToken.balanceOf(partyA.address)).to.equal(stakeAmount);
    });
  });
});
