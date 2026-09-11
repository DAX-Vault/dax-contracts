import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("====================================================");
  console.log("DAX V2 Mainnet Smart Contract Protocol Deployment");
  console.log("====================================================");
  console.log("Deployer Wallet Address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance :", hre.ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.error("❌ ERROR: Deployer wallet has 0 ETH on target network.");
    process.exit(1);
  }

  // Canonical Arbitrum One / Base USDC Address
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  
  // Default USDT/USDC by chain
  let stakingTokenAddress = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"; // Arbitrum One USDT
  if (chainId === 8453) {
    stakingTokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
  }

  // 1. Deploy DAX_Court
  console.log("\n1. Deploying DAX_Court...");
  const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
  const platformAuthority = process.env.PLATFORM_AUTHORITY || deployer.address;
  const court = await DAX_Court.deploy(stakingTokenAddress, platformAuthority);
  await court.waitForDeployment();
  const courtAddress = await court.getAddress();
  console.log("✅ DAX_Court deployed at:", courtAddress);

  // 2. Deploy DAX_Agreement
  console.log("\n2. Deploying DAX_Agreement...");
  const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const treasuryFeeBps = 25; // 0.25% fee
  const trustedForwarder = process.env.FORWARDER_ADDRESS || hre.ethers.ZeroAddress;
  const agreement = await DAX_Agreement.deploy(treasury, treasuryFeeBps, courtAddress, trustedForwarder);
  await agreement.waitForDeployment();
  const agreementAddress = await agreement.getAddress();
  console.log("✅ DAX_Agreement deployed at:", agreementAddress);

  // 3. Link DAX_Court -> DAX_Agreement
  console.log("\n3. Linking Court -> Agreement contract...");
  const tx = await court.setAgreementContract(agreementAddress);
  await tx.wait();
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 4. Deploy DAX_OfferPool
  console.log("\n4. Deploying DAX_OfferPool...");
  const DAX_OfferPool = await hre.ethers.getContractFactory("DAX_OfferPool");
  const offerPool = await DAX_OfferPool.deploy(agreementAddress);
  await offerPool.waitForDeployment();
  const offerPoolAddress = await offerPool.getAddress();
  console.log("✅ DAX_OfferPool deployed at:", offerPoolAddress);

  // 5. Save Deployment Metadata
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentData = {
    network: network.name,
    chainId,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    courtAddress,
    agreementAddress,
    offerPoolAddress,
    stakingTokenAddress,
    treasury,
    treasuryFeeBps,
    platformAuthority,
    trustedForwarder,
  };

  const filename = chainId === 8453 ? "base_mainnet.json" : "arbitrum_mainnet.json";
  const outputPath = path.join(deploymentDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log("\nSaved mainnet deployment artifact to:", outputPath);
  console.log("====================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
