import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("=================================================");
  console.log("DAX V2 Arbitrum Sepolia Smart Contract Deployment");
  console.log("=================================================");
  console.log("Deployer Address :", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance :", hre.ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.error("❌ ERROR: Deployer wallet has 0 ETH on Arbitrum Sepolia.");
    console.error("Please send Arbitrum Sepolia ETH to:", deployer.address);
    process.exit(1);
  }

  // Official Arbitrum Sepolia Testnet Token Address for Staking (or deploy mock)
  const usdtAddress = "0x808A56360F6c9B4b8eE5f3F46e885c39ef1A8f52";

  // 1. Deploy DAX_Court
  console.log("\n1. Deploying DAX_Court...");
  const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
  const court = await DAX_Court.deploy(usdtAddress);
  await court.waitForDeployment();
  const courtAddress = await court.getAddress();
  console.log("✅ DAX_Court deployed at:", courtAddress);

  // 2. Deploy DAX_Agreement
  console.log("\n2. Deploying DAX_Agreement...");
  const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
  const treasury = deployer.address;
  const treasuryFeeBps = 50; // 0.5% fee
  const trustedForwarder = hre.ethers.ZeroAddress; 
  const agreement = await DAX_Agreement.deploy(treasury, treasuryFeeBps, courtAddress, trustedForwarder);
  await agreement.waitForDeployment();
  const agreementAddress = await agreement.getAddress();
  console.log("✅ DAX_Agreement deployed at:", agreementAddress);

  // 3. Link DAX_Court -> DAX_Agreement permanently
  console.log("\n3. Linking Court -> Agreement contract...");
  const tx = await court.setAgreementContract(agreementAddress);
  await tx.wait();
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 4. Save Deployment Information
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentData = {
    network: "arbitrumSepolia",
    chainId: 421614,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    courtAddress,
    agreementAddress,
    treasury,
    treasuryFeeBps,
    trustedForwarder,
    explorer: {
      court: `https://sepolia.arbiscan.io/address/${courtAddress}`,
      agreement: `https://sepolia.arbiscan.io/address/${agreementAddress}`,
    },
  };

  const outputPath = path.join(deploymentDir, "arbitrum_sepolia.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log("\nSaved deployment artifact to:", outputPath);
  console.log("=================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
