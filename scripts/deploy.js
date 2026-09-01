import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Deploy platform token first (used for arbitration stakes)
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const daxToken = await MockTokenFactory.deploy("DAX Platform Token", "DAX", ethers.parseEther("10000000"));
  await daxToken.waitForDeployment();
  const daxTokenAddr = await daxToken.getAddress();
  console.log("DAX Platform Token deployed to:", daxTokenAddr);

  const usdtToken = await MockTokenFactory.deploy("Tether USD", "USDT", ethers.parseEther("10000000"));
  await usdtToken.waitForDeployment();
  const usdtTokenAddr = await usdtToken.getAddress();
  console.log("Mock USDT deployed to:", usdtTokenAddr);

  const usdcToken = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseEther("10000000"));
  await usdcToken.waitForDeployment();
  const usdcTokenAddr = await usdcToken.getAddress();
  console.log("Mock USDC deployed to:", usdcTokenAddr);

  const wethToken = await MockTokenFactory.deploy("Wrapped Ether", "WETH", ethers.parseEther("10000000"));
  await wethToken.waitForDeployment();
  const wethTokenAddr = await wethToken.getAddress();
  console.log("Mock WETH deployed to:", wethTokenAddr);

  // Deploy AMM Swap router
  const AMMFactory = await ethers.getContractFactory("DAX_AMM");
  // Deployer acts as the temporary treasury, can be updated later
  const amm = await AMMFactory.deploy(deployer.address);
  await amm.waitForDeployment();
  console.log("DAX AMM deployed to:", await amm.getAddress());

  // Deploy P2P Escrow contract
  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2p = await P2PFactory.deploy(deployer.address, daxTokenAddr);
  await p2p.waitForDeployment();
  console.log("DAX P2P Escrow deployed to:", await p2p.getAddress());

  // Deploy DAX_Agreement Protocol contract
  const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
  const agreement = await AgreementFactory.deploy(
    deployer.address, // Treasury
    25,               // 0.25% protocol fee
    deployer.address, // Initial Dispute Court (Deployer/Safety Council)
    deployer.address  // Initial Trusted Forwarder
  );
  await agreement.waitForDeployment();
  console.log("DAX_Agreement Protocol deployed to:", await agreement.getAddress());

  console.log("Deployment finished successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
