import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer, userA, userB] = await hre.ethers.getSigners();
  console.log("=================================================");
  console.log("DAX V2 Local EVM Hardhat Node Deployment");
  console.log("=================================================");
  console.log("Deployer Address :", deployer.address);
  console.log("User A Address   :", userA.address);
  console.log("User B Address   :", userB.address);

  // 1. Deploy Mock USDT & Mock USDC
  console.log("\n1. Deploying Mock Tokens (USDT & USDC)...");
  const MockToken = await hre.ethers.getContractFactory("MockToken");
  
  const initialSupply = hre.ethers.parseUnits("1000000", 6); // 1M tokens
  const usdt = await MockToken.deploy("Tether USD", "USDT", initialSupply);
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();
  console.log("✅ Mock USDT deployed at:", usdtAddress);

  const usdc = await MockToken.deploy("USD Coin", "USDC", initialSupply);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("✅ Mock USDC deployed at:", usdcAddress);

  // 2. Deploy DAX_Court (takes staking token, using USDT for court staking)
  console.log("\n2. Deploying DAX_Court...");
  const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
  const court = await DAX_Court.deploy(usdtAddress);
  await court.waitForDeployment();
  const courtAddress = await court.getAddress();
  console.log("✅ DAX_Court deployed at:", courtAddress);

  // 3. Deploy DAX_Agreement (treasury, feeBps, courtAddress, trustedForwarder)
  console.log("\n3. Deploying DAX_Agreement...");
  const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
  const treasury = deployer.address;
  const treasuryFeeBps = 50; // 0.5% fee
  const trustedForwarder = hre.ethers.ZeroAddress; 
  const agreement = await DAX_Agreement.deploy(treasury, treasuryFeeBps, courtAddress, trustedForwarder);
  await agreement.waitForDeployment();
  const agreementAddress = await agreement.getAddress();
  console.log("✅ DAX_Agreement deployed at:", agreementAddress);

  // 4. Link DAX_Court -> DAX_Agreement permanently
  console.log("\n4. Linking Court -> Agreement contract...");
  const txLink = await court.setAgreementContract(agreementAddress);
  await txLink.wait();
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 5. Deploy DAX_OfferPool
  console.log("\n5. Deploying DAX_OfferPool (Matching & Registry Layer)...");
  const DAX_OfferPool = await hre.ethers.getContractFactory("DAX_OfferPool");
  const offerPool = await DAX_OfferPool.deploy(agreementAddress);
  await offerPool.waitForDeployment();
  const offerPoolAddress = await offerPool.getAddress();
  console.log("✅ DAX_OfferPool deployed at:", offerPoolAddress);

  // Fund User A and User B with test USDT and USDC
  const fundAmount = hre.ethers.parseUnits("50000", 6); // 50k tokens each
  await usdt.transfer(userA.address, fundAmount);
  await usdt.transfer(userB.address, fundAmount);
  await usdc.transfer(userA.address, fundAmount);
  await usdc.transfer(userB.address, fundAmount);
  console.log("✅ Funded User A and User B with 50,000 USDT and 50,000 USDC each!");

  // 6. Save Deployment Information
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentData = {
    network: "localhost",
    chainId: 31337,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    userA: userA.address,
    userB: userB.address,
    courtAddress,
    agreementAddress,
    offerPoolAddress,
    usdtAddress,
    usdcAddress,
    treasury,
    treasuryFeeBps,
    trustedForwarder,
  };

  const outputPath = path.join(deploymentDir, "local.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log("\nSaved local deployment artifact to:", outputPath);
  console.log("=================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
