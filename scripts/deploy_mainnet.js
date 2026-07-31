import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Deploying contracts to Arbitrum Mainnet...");
  console.log("Deployer Wallet Address:", deployer.address);
  console.log("====================================================\n");

  // 1. Deploy the native DAX Platform Token (used for arbitration staking & ecosystem)
  console.log("Deploying DAX Platform Token...");
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const daxToken = await MockTokenFactory.deploy("DAX Platform Token", "DAX", ethers.parseEther("10000000"));
  await daxToken.waitForDeployment();
  const daxTokenAddr = await daxToken.getAddress();
  console.log("✔ DAX Platform Token deployed to:", daxTokenAddr);

  // 2. Deploy the DAX P2P Escrow Contract
  console.log("Deploying DAX P2P Escrow...");
  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2p = await P2PFactory.deploy(deployer.address, daxTokenAddr); // Treasury, arbitration token
  await p2p.waitForDeployment();
  const p2pAddr = await p2p.getAddress();
  console.log("✔ DAX P2P Escrow deployed to:", p2pAddr);

  console.log("\n====================================================");
  console.log("DEPLOYMENT COMPLETED SUCCESSFULLY!");
  console.log("====================================================");
  console.log("Save these contract addresses for your Flutter app config:");
  console.log(`- DAX Token: ${daxTokenAddr}`);
  console.log(`- DAX P2P:   ${p2pAddr}`);
  console.log("====================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
