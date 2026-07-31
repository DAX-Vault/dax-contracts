import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [owner, buyer, seller] = await ethers.getSigners();

  // Deploy Mock Token
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const token = await MockTokenFactory.deploy("Mock USD", "USDT", ethers.parseEther("1000000"));
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  // Mint to buyer/seller
  await token.transfer(seller.address, ethers.parseEther("10000"));
  await token.transfer(buyer.address, ethers.parseEther("10000"));

  // Deploy P2P
  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2p = await P2PFactory.deploy(owner.address, tokenAddr);
  await p2p.waitForDeployment();
  const p2pAddr = await p2p.getAddress();

  console.log("\n====================================================");
  console.log("DAX P2P Gas Estimation Report (in Gas Units)");
  console.log("====================================================\n");

  // 1. Approve P2P contract
  let tx = await token.connect(seller).approve(p2pAddr, ethers.parseEther("100"));
  let receipt = await tx.wait();
  console.log(`1. Token Approval (approve): ${receipt.gasUsed.toString()} gas`);

  // 2. Create Ad (isSellAd = true)
  tx = await p2p.connect(seller).createAd(
    tokenAddr,
    ethers.parseEther("100"),
    ethers.parseEther("10"),
    ethers.parseEther("100"),
    60000000n, // $60 rate
    "USD",
    "Revolut",
    true // isSellAd
  );
  receipt = await tx.wait();
  console.log(`2. Create Sell Ad (createAd): ${receipt.gasUsed.toString()} gas`);

  // 3. Initiate Trade
  tx = await p2p.connect(buyer).initiateTrade(1, ethers.parseEther("20"));
  receipt = await tx.wait();
  console.log(`3. Initiate Trade (initiateTrade): ${receipt.gasUsed.toString()} gas`);

  // 4. Mark Paid
  tx = await p2p.connect(buyer).markPaid(1);
  receipt = await tx.wait();
  console.log(`4. Mark Paid (markPaid): ${receipt.gasUsed.toString()} gas`);

  // 5. Release Trade
  tx = await p2p.connect(seller).releaseTrade(1);
  receipt = await tx.wait();
  console.log(`5. Release Escrow (releaseTrade): ${receipt.gasUsed.toString()} gas`);

  // 6. Create another Ad to test Cancel Ad
  await token.connect(seller).approve(p2pAddr, ethers.parseEther("50"));
  tx = await p2p.connect(seller).createAd(
    tokenAddr,
    ethers.parseEther("50"),
    ethers.parseEther("5"),
    ethers.parseEther("50"),
    60000000n,
    "USD",
    "Revolut",
    true
  );
  await tx.wait();

  // Cancel Ad
  tx = await p2p.connect(seller).cancelAd(2);
  receipt = await tx.wait();
  console.log(`6. Cancel Ad (cancelAd): ${receipt.gasUsed.toString()} gas`);

  // 7. Create another Ad and Trade to test Cancel Trade (expiration)
  await token.connect(seller).approve(p2pAddr, ethers.parseEther("50"));
  await p2p.connect(seller).createAd(
    tokenAddr,
    ethers.parseEther("50"),
    ethers.parseEther("5"),
    ethers.parseEther("50"),
    60000000n,
    "USD",
    "Revolut",
    true
  );
  await p2p.connect(buyer).initiateTrade(3, ethers.parseEther("10"));

  // Fast forward time
  await ethers.provider.send("evm_increaseTime", [31 * 60]);
  await ethers.provider.send("evm_mine");

  tx = await p2p.connect(seller).cancelTrade(2);
  receipt = await tx.wait();
  console.log(`7. Cancel Trade & Restore (cancelTrade): ${receipt.gasUsed.toString()} gas`);

  console.log("\n====================================================");
  console.log("Arbitrum Mainnet Gas Cost Calculation (USD equivalent):");
  console.log("Typically, Arbitrum gas price is around 0.1 Gwei.");
  console.log("L1 fee is around 0.00001 - 0.00003 ETH per tx.");
  console.log("Total typical cost on Arbitrum is less than $0.05 per action.");
  console.log("====================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
