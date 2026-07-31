import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Deploying SECURE DAX P2P Escrow to Arbitrum Mainnet...");
  console.log("Deployer Wallet Address:", deployer.address);
  console.log("====================================================\n");

  const newDaxTokenAddr = "0xAB1Da50c33D43b27fF96e502cBaC99e8EB378A92";

  console.log("Deploying DAX_P2P...");
  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2p = await P2PFactory.deploy(deployer.address, newDaxTokenAddr); // Treasury, New secure token
  
  await p2p.waitForDeployment();
  const p2pAddr = await p2p.getAddress();

  console.log("\n====================================================");
  console.log("✔ DAX P2P Escrow successfully deployed to:", p2pAddr);
  console.log("Referenced Token Address:", newDaxTokenAddr);
  console.log("====================================================");
  console.log("\nVerification command:");
  console.log(`npx hardhat verify --network arbitrum ${p2pAddr} "${deployer.address}" "${newDaxTokenAddr}"`);
  console.log("====================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
