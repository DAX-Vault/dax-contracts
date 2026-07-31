import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Deploying SECURE DAX Token to Arbitrum Mainnet...");
  console.log("Deployer Wallet Address:", deployer.address);
  console.log("====================================================\n");

  // Mint 10,000,000 DAX tokens (18 decimals)
  const initialSupply = ethers.parseEther("10000000");

  console.log("Deploying DAXToken...");
  const DAXTokenFactory = await ethers.getContractFactory("DAXToken");
  const daxToken = await DAXTokenFactory.deploy(initialSupply);
  
  await daxToken.waitForDeployment();
  const daxTokenAddr = await daxToken.getAddress();
  
  console.log("\n====================================================");
  console.log("✔ DAXToken successfully deployed to:", daxTokenAddr);
  console.log("Total Supply Minted: 10,000,000 DAX");
  console.log("====================================================");
  console.log("\nVerification command:");
  console.log(`npx hardhat verify --network arbitrum ${daxTokenAddr} "10000000000000000000000000"`);
  console.log("====================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
