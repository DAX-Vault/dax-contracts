import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer, seller, buyer] = await ethers.getSigners();

  console.log("=========================================");
  console.log("      🚀 DAX P2P AUTOMATED TEST FLOW     ");
  console.log("=========================================");

  // 1. Deploy contract instances for test
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const daxToken = await MockTokenFactory.deploy("DAX Platform Token", "DAX", ethers.parseEther("10000000"));
  await daxToken.waitForDeployment();
  const daxAddress = await daxToken.getAddress();

  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2pContract = await P2PFactory.deploy(deployer.address, daxAddress);
  await p2pContract.waitForDeployment();
  const p2pAddress = await p2pContract.getAddress();

  // Mint some tokens to seller and buyer for P2P trading
  console.log("Minting 10,000 DAX tokens to seller & buyer...");
  await (await daxToken.mint(seller.address, ethers.parseEther("10000"))).wait();
  await (await daxToken.mint(buyer.address, ethers.parseEther("10000"))).wait();

  // 2. Approve P2P contract to spend seller's DAX
  const adAmount = ethers.parseEther("200");
  console.log("Seller approving P2P router to hold 200 DAX...");
  await (await daxToken.connect(seller).approve(p2pAddress, adAmount)).wait();

  // 3. Create a Sell Ad
  console.log("Seller creating Sell Ad for 200 DAX at rate of 1.50 USD...");
  const rate = 1500000; // 1.50 USD * 10^6
  const minLimit = ethers.parseEther("20");
  const maxLimit = ethers.parseEther("200");
  
  const createAdTx = await p2pContract.connect(seller).createAd(
    daxAddress,
    adAmount,
    minLimit,
    maxLimit,
    rate,
    "USD",
    "Revolut",
    true // isSellAd
  );
  const createAdReceipt = await createAdTx.wait();
  
  // Find adId from event logs
  const adCount = await p2pContract.adCount();
  console.log(`✅ Ad successfully created! Ad ID: ${adCount.toString()}`);

  // 4. Buyer initiates trade on this Ad
  const tradeAmount = ethers.parseEther("50");
  console.log(`Buyer initiating trade for ${ethers.formatEther(tradeAmount)} DAX...`);
  const initTradeTx = await p2pContract.connect(buyer).initiateTrade(adCount, tradeAmount);
  await initTradeTx.wait();
  
  const tradeCount = await p2pContract.tradeCount();
  console.log(`✅ Trade successfully matched! Trade ID: ${tradeCount.toString()}`);

  // 5. Buyer marks trade as paid
  console.log("Buyer marking trade as PAID in fiat...");
  await (await p2pContract.connect(buyer).markPaid(tradeCount)).wait();
  console.log("✅ Trade status updated to PAID on-chain!");

  // 6. Seller releases trade escrow
  const buyerBalanceBefore = await daxToken.balanceOf(buyer.address);
  console.log(`Buyer DAX balance before release: ${ethers.formatEther(buyerBalanceBefore)}`);

  console.log("Seller confirming receipt and releasing escrow...");
  const releaseTx = await p2pContract.connect(seller).releaseTrade(tradeCount);
  await releaseTx.wait();
  console.log("✅ Escrow successfully released!");

  const buyerBalanceAfter = await daxToken.balanceOf(buyer.address);
  console.log(`Buyer DAX balance after release: ${ethers.formatEther(buyerBalanceAfter)}`);

  const netGained = buyerBalanceAfter - buyerBalanceBefore;
  console.log(`🔥 Net DAX transferred to buyer: ${ethers.formatEther(netGained)} (Minus 0.1% protocol developer treasury fee!)`);
  console.log("=========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
