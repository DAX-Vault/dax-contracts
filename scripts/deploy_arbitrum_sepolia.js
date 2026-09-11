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

  const treasury = deployer.address;
  const treasuryFeeBps = 25; // 0.25% fee
  const trustedForwarder = hre.ethers.ZeroAddress; 

  // 1. Deploy DAX_Token (100,000,000 DAX fixed supply)
  console.log("\n1. Deploying DAX_Token (100,000,000 DAX)...");
  const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
  const daxToken = await DAX_Token.deploy(deployer.address);
  await daxToken.waitForDeployment();
  const daxTokenAddress = await daxToken.getAddress();
  console.log("✅ DAX_Token deployed at:", daxTokenAddress);

  // 2. Deploy DAX_Court (staked with canonical DAX_Token)
  console.log("\n2. Deploying DAX_Court...");
  const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
  const court = await DAX_Court.deploy(daxTokenAddress, deployer.address);
  await court.waitForDeployment();
  const courtAddress = await court.getAddress();
  console.log("✅ DAX_Court deployed at:", courtAddress);

  // 3. Deploy DAX_Agreement
  console.log("\n3. Deploying DAX_Agreement...");
  const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
  const agreement = await DAX_Agreement.deploy(treasury, treasuryFeeBps, courtAddress, trustedForwarder);
  await agreement.waitForDeployment();
  const agreementAddress = await agreement.getAddress();
  console.log("✅ DAX_Agreement deployed at:", agreementAddress);

  // 4. Link DAX_Court -> DAX_Agreement permanently
  console.log("\n4. Linking Court -> Agreement contract...");
  const tx = await court.setAgreementContract(agreementAddress);
  await tx.wait();
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 5. Deploy DAX_OfferPool (Matching & Slicing Vault)
  console.log("\n5. Deploying DAX_OfferPool...");
  const DAX_OfferPool = await hre.ethers.getContractFactory("DAX_OfferPool");
  const offerPool = await DAX_OfferPool.deploy(agreementAddress);
  await offerPool.waitForDeployment();
  const offerPoolAddress = await offerPool.getAddress();
  console.log("✅ DAX_OfferPool deployed at:", offerPoolAddress);

  // 6. Deploy DAX_Swap (Swap Digital Assets -> DAX with 100% forwarded to deployed ledger)
  console.log("\n6. Deploying DAX_Swap...");
  const DAX_Swap = await hre.ethers.getContractFactory("DAX_Swap");
  const initialEthRate = hre.ethers.parseEther("25000"); // 1 ETH = 25,000 DAX
  const swap = await DAX_Swap.deploy(daxTokenAddress, treasury, initialEthRate);
  await swap.waitForDeployment();
  const swapAddress = await swap.getAddress();
  console.log("✅ DAX_Swap deployed at:", swapAddress);

  // 7. Configure USDT swap rate and seed initial DAX liquidity
  console.log("\n7. Seeding initial DAX liquidity to DAX_Swap...");
  const initialLiquidity = hre.ethers.parseEther("10000000"); // 10,000,000 DAX
  const seedTx = await daxToken.transfer(swapAddress, initialLiquidity);
  await seedTx.wait();
  console.log("✅ Seeded 10,000,000 DAX liquidity to swap gate!");

  // 8. Save Deployment Information
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentData = {
    network: "arbitrumSepolia",
    chainId: 421614,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    daxTokenAddress,
    courtAddress,
    agreementAddress,
    offerPoolAddress,
    swapAddress,
    treasury,
    treasuryFeeBps,
    trustedForwarder,
    explorer: {
      daxToken: `https://sepolia.arbiscan.io/address/${daxTokenAddress}`,
      court: `https://sepolia.arbiscan.io/address/${courtAddress}`,
      agreement: `https://sepolia.arbiscan.io/address/${agreementAddress}`,
      offerPool: `https://sepolia.arbiscan.io/address/${offerPoolAddress}`,
      swap: `https://sepolia.arbiscan.io/address/${swapAddress}`,
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
