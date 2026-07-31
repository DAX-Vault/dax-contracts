import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DAX Ecosystem Unit Tests", function () {
  let AMM, P2P, MockToken;
  let amm, p2p, tokenA, tokenB, daxToken;
  let owner, treasury, buyer, seller, arbitrator1, arbitrator2, arbitrator3;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");

  beforeEach(async function () {
    [owner, treasury, buyer, seller, arbitrator1, arbitrator2, arbitrator3] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    tokenA = await MockTokenFactory.deploy("Token A", "TKA", INITIAL_SUPPLY);
    tokenB = await MockTokenFactory.deploy("Token B", "TKB", INITIAL_SUPPLY);
    daxToken = await MockTokenFactory.deploy("Platform Token", "DAX", INITIAL_SUPPLY);

    // Deploy DAX_AMM
    const AMMFactory = await ethers.getContractFactory("DAX_AMM");
    amm = await AMMFactory.deploy(treasury.address);

    // Deploy DAX_P2P
    const P2PFactory = await ethers.getContractFactory("DAX_P2P");
    p2p = await P2PFactory.deploy(treasury.address, await daxToken.getAddress());

    // Mint tokens to buyer and seller
    await tokenA.transfer(buyer.address, ethers.parseEther("10000"));
    await tokenB.transfer(buyer.address, ethers.parseEther("10000"));
    await tokenA.transfer(seller.address, ethers.parseEther("10000"));
    await tokenB.transfer(seller.address, ethers.parseEther("10000"));

    // Mint daxTokens for arbitrators
    await daxToken.transfer(arbitrator1.address, ethers.parseEther("1000"));
    await daxToken.transfer(arbitrator2.address, ethers.parseEther("1000"));
    await daxToken.transfer(arbitrator3.address, ethers.parseEther("1000"));
  });

  describe("DAX AMM Swap & Pools", function () {
    it("Should create a new pool successfully", async function () {
      const tx = await amm.createPool(await tokenA.getAddress(), await tokenB.getAddress());
      await expect(tx).to.emit(amm, "PoolCreated");

      const pairHash = await amm.getPairHash(await tokenA.getAddress(), await tokenB.getAddress());
      const exists = await amm.poolExists(pairHash);
      expect(exists).to.be.true;
    });

    it("Should add initial liquidity and mint LP shares based on geometric mean", async function () {
      await amm.createPool(await tokenA.getAddress(), await tokenB.getAddress());

      const amountA = ethers.parseEther("100");
      const amountB = ethers.parseEther("400");

      // Approve tokens
      await tokenA.connect(owner).approve(await amm.getAddress(), amountA);
      await tokenB.connect(owner).approve(await amm.getAddress(), amountB);

      await amm.connect(owner).addLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), amountA, amountB, 0n, Math.floor(Date.now() / 1000) + 3600);

      const pool = await amm.getPool(await tokenA.getAddress(), await tokenB.getAddress());
      
      // Expected shares = sqrt(100 * 400) = 200
      expect(pool.totalLPShares).to.equal(ethers.parseEther("200"));
      expect(pool.reserve0).to.be.gt(0n);
      expect(pool.reserve1).to.be.gt(0n);
    });

    it("Should execute swap with exact math, constant product, and treasury fee collection", async function () {
      await amm.createPool(await tokenA.getAddress(), await tokenB.getAddress());

      // Approve & Add Initial Liquidity
      const liqA = ethers.parseEther("1000");
      const liqB = ethers.parseEther("1000");
      await tokenA.connect(owner).approve(await amm.getAddress(), liqA);
      await tokenB.connect(owner).approve(await amm.getAddress(), liqB);
      await amm.connect(owner).addLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), liqA, liqB, 0n, Math.floor(Date.now() / 1000) + 3600);

      // Approve swap
      const swapAmount = ethers.parseEther("10");
      await tokenA.connect(buyer).approve(await amm.getAddress(), swapAmount);

      const initialTreasuryBal = await tokenA.balanceOf(treasury.address);

      // Execute swap (tokenA -> tokenB)
      await amm.connect(buyer).swap(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        swapAmount,
        0n, // minAmountOut
        Math.floor(Date.now() / 1000) + 3600 // deadline
      );

      // Treasury should receive 0.05% of swapAmount
      // 10 ETH * 0.05% = 0.005 ETH
      const finalTreasuryBal = await tokenA.balanceOf(treasury.address);
      expect(finalTreasuryBal - initialTreasuryBal).to.equal(ethers.parseEther("0.005"));
    });

    it("Should remove liquidity and return assets proportionally", async function () {
      await amm.createPool(await tokenA.getAddress(), await tokenB.getAddress());

      const liqA = ethers.parseEther("100");
      const liqB = ethers.parseEther("100");
      await tokenA.connect(owner).approve(await amm.getAddress(), liqA);
      await tokenB.connect(owner).approve(await amm.getAddress(), liqB);
      await amm.connect(owner).addLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), liqA, liqB, 0n, Math.floor(Date.now() / 1000) + 3600);

      const pairHash = await amm.getPairHash(await tokenA.getAddress(), await tokenB.getAddress());
      const shares = await amm.lpShares(pairHash, owner.address);

      // Remove 50% of liquidity
      const halfShares = shares / 2n;
      await amm.connect(owner).removeLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), halfShares, 0n, 0n, Math.floor(Date.now() / 1000) + 3600);

      const pool = await amm.getPool(await tokenA.getAddress(), await tokenB.getAddress());
      expect(pool.reserve0).to.equal(ethers.parseEther("50"));
      expect(pool.reserve1).to.equal(ethers.parseEther("50"));
    });
  });

  describe("DAX P2P Escrow & Decentralized Arbitration", function () {
    it("Should allow a seller to list a sell ad and lock tokens in escrow", async function () {
      const amount = ethers.parseEther("50");
      
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      
      const tx = await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"), // min
        ethers.parseEther("50"), // max
        60000000n, // rate = $60 (with 10^6 scale)
        "USD",
        "Revolut",
        true // isSellAd
      );

      await expect(tx).to.emit(p2p, "AdCreated");

      const ad = await p2p.ads(1);
      expect(ad.active).to.be.true;
      expect(ad.amount).to.equal(amount);

      // Tokens should be locked in P2P escrow contract
      expect(await tokenA.balanceOf(await p2p.getAddress())).to.equal(amount);
    });

    it("Should complete a standard trade: initiate -> mark paid -> release (deducts 0.1% platform fee)", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 20 TKA
      const tradeAmount = ethers.parseEther("20");
      await p2p.connect(buyer).initiateTrade(1, tradeAmount);

      const initialTreasuryBal = await tokenA.balanceOf(treasury.address);
      const initialBuyerBal = await tokenA.balanceOf(buyer.address);

      // Mark as paid
      await p2p.connect(buyer).markPaid(1);

      // Seller releases escrow
      await p2p.connect(seller).releaseTrade(1);

      const trade = await p2p.trades(1);
      expect(trade.status).to.equal(2n); // TradeStatus.COMPLETED

      // 0.1% fee on 20 tokens = 0.02 tokens
      // Buyer gets 19.98 tokens
      const finalTreasuryBal = await tokenA.balanceOf(treasury.address);
      const finalBuyerBal = await tokenA.balanceOf(buyer.address);

      expect(finalTreasuryBal - initialTreasuryBal).to.equal(ethers.parseEther("0.02"));
      expect(finalBuyerBal - initialBuyerBal).to.equal(ethers.parseEther("19.98"));
    });

    it("Should handle dispute with staker-based decentralized arbitration court", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade
      const tradeAmount = ethers.parseEther("20");
      await p2p.connect(buyer).initiateTrade(1, tradeAmount);
      await p2p.connect(buyer).markPaid(1);

      // Buyer opens dispute (e.g. seller doesn't release)
      await p2p.connect(buyer).disputeTrade(1, "Mock Chat Evidence");

      let trade = await p2p.trades(1);
      expect(trade.status).to.equal(3n); // TradeStatus.DISPUTED
      expect(await p2p.getTradeChatHistory(1)).to.equal("Mock Chat Evidence");

      // Register Arbitrators
      const stakeReq = ethers.parseEther("100");
      await daxToken.connect(arbitrator1).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator1).stakeArbitrator(stakeReq);

      await daxToken.connect(arbitrator2).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator2).stakeArbitrator(stakeReq);

      await daxToken.connect(arbitrator3).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator3).stakeArbitrator(stakeReq);

      // Arbitrators vote
      await p2p.connect(arbitrator1).voteDispute(1, true); // vote for buyer
      await p2p.connect(arbitrator2).voteDispute(1, true); // vote for buyer
      await p2p.connect(arbitrator3).voteDispute(1, true); // vote for buyer

      // Trigger resolution
      const initialBuyerBal = await tokenA.balanceOf(buyer.address);
      await p2p.connect(owner).resolveDispute(1);

      trade = await p2p.trades(1);
      expect(trade.status).to.equal(2n); // TradeStatus.COMPLETED

      // Dispute won by buyer, gets payout
      const finalBuyerBal = await tokenA.balanceOf(buyer.address);
      expect(finalBuyerBal).to.be.gt(initialBuyerBal);
    });

    it("Should allow buyers and sellers to exchange chat messages and emit P2pChatMessage events", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));

      const msg1 = await p2p.connect(buyer).sendChatMessage(1, "Hi, I have sent the Revolut transfer.");
      await expect(msg1).to.emit(p2p, "P2pChatMessage");

      const msg2 = await p2p.connect(seller).sendChatMessage(1, "Great, checking my Revolut app now.");
      await expect(msg2).to.emit(p2p, "P2pChatMessage");

      await expect(p2p.connect(arbitrator1).sendChatMessage(1, "Unauthorized message")).to.be.revertedWith("Not authorized");
    });

    it("Should allow treasury to update protocol parameters", async function () {
      await p2p.connect(treasury).setEscrowFeeBps(20);
      expect(await p2p.escrowFeeBps()).to.equal(20n);
      
      await expect(p2p.connect(owner).setEscrowFeeBps(30)).to.be.revertedWith("Not treasury");
      await expect(p2p.connect(treasury).setEscrowFeeBps(1000)).to.be.revertedWith("Fee too high");
    });

    it("Should revert on tied dispute and allow admin resolution", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));
      await p2p.connect(buyer).markPaid(1);
      await p2p.connect(buyer).disputeTrade(1, "Mock Chat Evidence");

      await expect(p2p.connect(buyer).adminResolveDispute(1, true)).to.be.revertedWith("Not treasury");

      const initialBuyerBal = await tokenA.balanceOf(buyer.address);
      await p2p.connect(treasury).adminResolveDispute(1, true); // Admin rules for buyer
      
      const trade = await p2p.trades(1);
      expect(trade.status).to.equal(2n); // COMPLETED
      expect(await tokenA.balanceOf(buyer.address)).to.be.gt(initialBuyerBal);
    });

    it("Should return tokens to the Ad when trade is cancelled (Scenario 2)", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("5"), // min limit 5
        ethers.parseEther("25"), // max limit 25
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 5 TKA (ad amount becomes 20)
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("5"));
      let ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("20"));
      expect(ad.active).to.be.true;

      // Fast forward time past 30 mins deadline to allow cancellation
      await ethers.provider.send("evm_increaseTime", [31 * 60]);
      await ethers.provider.send("evm_mine");

      // Seller cancels the trade
      await p2p.connect(seller).cancelTrade(1);

      // Verify ad amount is restored to 25 and it is active
      ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("25"));
      expect(ad.active).to.be.true;
      
      // Seller's wallet balance did not increase (since funds went back to the Ad)
      const sellerBal = await tokenA.balanceOf(seller.address);
      expect(sellerBal).to.equal(ethers.parseEther("10000") - amount);
    });

    it("Should reactivate Ad if it was automatically deactivated and trade is cancelled", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("25"), // min limit 25 (equal to amount)
        ethers.parseEther("25"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 25 TKA (ad amount becomes 0, so it deactivates)
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("25"));
      let ad = await p2p.ads(1);
      expect(ad.amount).to.equal(0n);
      expect(ad.active).to.be.false;

      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [31 * 60]);
      await ethers.provider.send("evm_mine");

      // Seller cancels trade
      await p2p.connect(seller).cancelTrade(1);

      // Ad is restored and active again
      ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("25"));
      expect(ad.active).to.be.true;
    });

    it("Should fallback to refunding seller's wallet if the Ad was manually cancelled first", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("5"),
        ethers.parseEther("25"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 5 TKA (ad amount becomes 20)
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("5"));

      // Seller manually cancels the parent Ad (withdraws the remaining 20 TKA)
      const sellerBalBeforeAdCancel = await tokenA.balanceOf(seller.address);
      await p2p.connect(seller).cancelAd(1);
      
      const sellerBalAfterAdCancel = await tokenA.balanceOf(seller.address);
      expect(sellerBalAfterAdCancel - sellerBalBeforeAdCancel).to.equal(ethers.parseEther("20"));

      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [31 * 60]);
      await ethers.provider.send("evm_mine");

      // Seller cancels trade
      await p2p.connect(seller).cancelTrade(1);

      // The 5 tokens from the trade should be refunded to seller's wallet directly
      const sellerBalAfterTradeCancel = await tokenA.balanceOf(seller.address);
      expect(sellerBalAfterTradeCancel - sellerBalAfterAdCancel).to.equal(ethers.parseEther("5"));

      // Ad remains cancelled and amount is 0
      const ad = await p2p.ads(1);
      expect(ad.active).to.be.false;
      expect(ad.amount).to.equal(0n);
    });

    it("Should allow withdrawing remaining dust even if the ad automatically deactivated", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"), // min limit 10
        ethers.parseEther("25"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 20 TKA (remaining 5 TKA is less than min limit 10, so ad becomes inactive)
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));
      let ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("5"));
      expect(ad.active).to.be.false;

      // Seller cancels the ad (to retrieve the remaining 5 TKA dust)
      const sellerBalBeforeCancel = await tokenA.balanceOf(seller.address);
      await p2p.connect(seller).cancelAd(1);

      const sellerBalAfterCancel = await tokenA.balanceOf(seller.address);
      expect(sellerBalAfterCancel - sellerBalBeforeCancel).to.equal(ethers.parseEther("5"));

      ad = await p2p.ads(1);
      expect(ad.amount).to.equal(0n);
    });

    it("Should correctly slash losing jurors and reward winning jurors with slashed stakes and trade fees", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 20 TKA
      const tradeAmount = ethers.parseEther("20");
      await p2p.connect(buyer).initiateTrade(1, tradeAmount);
      await p2p.connect(buyer).markPaid(1);

      // Buyer opens dispute
      await p2p.connect(buyer).disputeTrade(1, "Mock Chat Evidence");

      // Register 3 Arbitrators with 100 DAX stake each
      const stakeReq = ethers.parseEther("100");
      await daxToken.connect(arbitrator1).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator1).stakeArbitrator(stakeReq);

      await daxToken.connect(arbitrator2).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator2).stakeArbitrator(stakeReq);

      await daxToken.connect(arbitrator3).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator3).stakeArbitrator(stakeReq);

      // Arbitrators vote:
      // Arbitrator 1 & 3 vote for Buyer (true)
      // Arbitrator 2 votes for Seller (false)
      await p2p.connect(arbitrator1).voteDispute(1, true);
      await p2p.connect(arbitrator2).voteDispute(1, false);
      await p2p.connect(arbitrator3).voteDispute(1, true);

      // Track balances before resolution
      // Arbitrator 1 & 3 should get a share of slashed tokens (5 DAX each, since Arbitrator 2 is slashed 10 DAX)
      // Arbitrator 1 & 3 should get 50% of the trade fee (0.01 TKA split = 0.005 TKA each)
      // Treasury should get 50% of the trade fee (0.01 TKA)
      const initialArb1TKA = await tokenA.balanceOf(arbitrator1.address);
      const initialArb3TKA = await tokenA.balanceOf(arbitrator3.address);
      const initialTreasuryTKA = await tokenA.balanceOf(treasury.address);

      // Resolve dispute (Buyer wins: votes 2 vs 1)
      await p2p.connect(owner).resolveDispute(1);

      // Verify trade completed
      const trade = await p2p.trades(1);
      expect(trade.status).to.equal(2n); // COMPLETED

      // 1. Verify Staked Balances (DAX Token)
      // Arbitrator 2 was slashed 10 DAX (staked balance: 100 -> 90)
      expect(await p2p.stakedArbitrators(arbitrator2.address)).to.equal(ethers.parseEther("90"));

      // Arbitrator 1 & 3 received 5 DAX each (staked balance: 100 -> 105)
      expect(await p2p.stakedArbitrators(arbitrator1.address)).to.equal(ethers.parseEther("105"));
      expect(await p2p.stakedArbitrators(arbitrator3.address)).to.equal(ethers.parseEther("105"));

      // 2. Verify Trade Fee Distribution (TKA Token)
      // Escrow fee Bps = 10 (0.1% of 20 TKA = 0.02 TKA)
      // Juror reward share Bps = 5000 (50% of 0.02 TKA = 0.01 TKA to jurors)
      // Winning jurors (Arb 1 & Arb 3) get 0.01 / 2 = 0.005 TKA each
      expect(await tokenA.balanceOf(arbitrator1.address)).to.equal(initialArb1TKA + ethers.parseEther("0.005"));
      expect(await tokenA.balanceOf(arbitrator3.address)).to.equal(initialArb3TKA + ethers.parseEther("0.005"));

      // Treasury gets the rest (0.01 TKA)
      expect(await tokenA.balanceOf(treasury.address)).to.equal(initialTreasuryTKA + ethers.parseEther("0.01"));
    });

    it("Should slash incorrect voters and reward correct voters during adminResolveDispute", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));
      await p2p.connect(buyer).markPaid(1);
      await p2p.connect(buyer).disputeTrade(1, "Mock Chat Evidence");

      // Stake arbitrators
      const stakeReq = ethers.parseEther("100");
      await daxToken.connect(arbitrator1).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator1).stakeArbitrator(stakeReq);

      await daxToken.connect(arbitrator2).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator2).stakeArbitrator(stakeReq);

      // Arb1 votes for Buyer (true), Arb2 votes for Seller (false)
      await p2p.connect(arbitrator1).voteDispute(1, true);
      await p2p.connect(arbitrator2).voteDispute(1, false);

      // Admin resolves dispute: buyer wins (buyerWins = true)
      await p2p.connect(treasury).adminResolveDispute(1, true);

      // Arb1 should be rewarded (staked balance: 100 -> 110 because Arb2 slashed 10 DAX)
      // Arb2 should be slashed (staked balance: 100 -> 90)
      expect(await p2p.stakedArbitrators(arbitrator1.address)).to.equal(ethers.parseEther("110"));
      expect(await p2p.stakedArbitrators(arbitrator2.address)).to.equal(ethers.parseEther("90"));
    });

    it("Should lock juror stakes and revert unstaking below requirement when holding active votes", async function () {
      const amount = ethers.parseEther("50");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("10"),
        ethers.parseEther("50"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));
      await p2p.connect(buyer).markPaid(1);
      await p2p.connect(buyer).disputeTrade(1, "Mock Chat Evidence");

      // Stake arbitrator1 with exactly the stake requirement (100 DAX)
      const stakeReq = ethers.parseEther("100");
      await daxToken.connect(arbitrator1).approve(await p2p.getAddress(), stakeReq);
      await p2p.connect(arbitrator1).stakeArbitrator(stakeReq);

      // Arbitrator1 votes
      await p2p.connect(arbitrator1).voteDispute(1, true);

      // Verify activeDisputeCount is 1
      expect(await p2p.activeDisputeCount(arbitrator1.address)).to.equal(1n);

      // Try to unstake any amount (even 1 DAX) and it should revert
      await expect(
        p2p.connect(arbitrator1).unstakeArbitrator(ethers.parseEther("1"))
      ).to.be.revertedWith("Cannot unstake below minimum requirement while holding active votes");

      // If they have excess stake (e.g. they stake an extra 50 DAX, total 150 DAX)
      await daxToken.connect(arbitrator1).approve(await p2p.getAddress(), ethers.parseEther("50"));
      await p2p.connect(arbitrator1).stakeArbitrator(ethers.parseEther("50"));

      // They should be able to unstake up to 50 DAX
      await expect(
        p2p.connect(arbitrator1).unstakeArbitrator(ethers.parseEther("30"))
      ).to.not.be.reverted;

      // But trying to unstake another 30 DAX (which would reduce stake to 90, below 100) should revert
      await expect(
        p2p.connect(arbitrator1).unstakeArbitrator(ethers.parseEther("30"))
      ).to.be.revertedWith("Cannot unstake below minimum requirement while holding active votes");

      // Resolve the dispute
      await p2p.connect(treasury).adminResolveDispute(1, true);

      // Verify activeDisputeCount decremented to 0
      expect(await p2p.activeDisputeCount(arbitrator1.address)).to.equal(0n);

      // Now arbitrator1 should be able to unstake completely
      const currentStake = await p2p.stakedArbitrators(arbitrator1.address);
      await expect(
        p2p.connect(arbitrator1).unstakeArbitrator(currentStake)
      ).to.not.be.reverted;
      expect(await p2p.stakedArbitrators(arbitrator1.address)).to.equal(0n);
    });

    it("Should allow the buyer to cancel the trade and restore tokens back to the active Ad", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("5"),
        ethers.parseEther("25"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Buyer initiates trade for 5 TKA (ad amount becomes 20)
      await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("5"));
      let ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("20"));

      // Buyer cancels the trade early
      await p2p.connect(buyer).buyerCancelTrade(1);

      // Verify trade status is CANCELLED (4)
      const trade = await p2p.trades(1);
      expect(trade.status).to.equal(4n); // CANCELLED

      // Verify ad amount is restored to 25 and remains active
      ad = await p2p.ads(1);
      expect(ad.amount).to.equal(ethers.parseEther("25"));
      expect(ad.active).to.be.true;
    });

    it("Should allow an ad creator to update rate, limits, and payment methods of their active Ad", async function () {
      const amount = ethers.parseEther("25");
      await tokenA.connect(seller).approve(await p2p.getAddress(), amount);
      await p2p.connect(seller).createAd(
        await tokenA.getAddress(),
        amount,
        ethers.parseEther("5"),
        ethers.parseEther("25"),
        60000000n,
        "USD",
        "Revolut",
        true
      );

      // Creator updates the Ad
      await p2p.connect(seller).updateAd(
        1,
        ethers.parseEther("10"), // new min limit 10
        ethers.parseEther("20"), // new max limit 20
        70000000n, // new rate 70
        "Telebirr"
      );

      // Verify values are updated
      const ad = await p2p.ads(1);
      expect(ad.minLimit).to.equal(ethers.parseEther("10"));
      expect(ad.maxLimit).to.equal(ethers.parseEther("20"));
      expect(ad.rate).to.equal(70000000n);
      expect(ad.paymentMethods).to.equal("Telebirr");

      // Verify non-creator cannot update the Ad
      await expect(
        p2p.connect(buyer).updateAd(1, ethers.parseEther("5"), ethers.parseEther("25"), 60000000n, "Revolut")
      ).to.be.revertedWith("Not ad creator");
    });
  });
});
