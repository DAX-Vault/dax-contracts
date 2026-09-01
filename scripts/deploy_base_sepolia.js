import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  console.log("=== DAX V2: Base Sepolia Testnet Protocol Deployment ===");

  const [deployer] = await ethers.getSigners();

  const network = await ethers.provider.getNetwork();
  console.log(`\nNetwork:  ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  // Official Base Sepolia USDC contract address
  const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || deployer.address;
  const FORWARDER_ADDRESS = process.env.FORWARDER_ADDRESS || deployer.address;

  console.log("\n1. Deploying DAX_Court...");
  const CourtFactory = await ethers.getContractFactory("DAX_Court");
  const daxCourt = await CourtFactory.deploy(BASE_SEPOLIA_USDC);
  await daxCourt.waitForDeployment();
  const courtAddr = await daxCourt.getAddress();
  console.log(` - DAX_Court Deployed at: ${courtAddr}`);

  console.log("\n2. Deploying DAX_Agreement...");
  const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
  const daxAgreement = await AgreementFactory.deploy(
    TREASURY_ADDRESS,
    25, // 0.25% fee
    courtAddr,
    FORWARDER_ADDRESS
  );
  await daxAgreement.waitForDeployment();
  const agreementAddr = await daxAgreement.getAddress();
  console.log(` - DAX_Agreement Deployed at: ${agreementAddr}`);

  console.log("\n3. Linking Agreement Contract to Court...");
  await daxCourt.setAgreementContract(agreementAddr);
  console.log(" - DAX_Court.setAgreementContract linked successfully!");

  console.log("\n=== DEPLOYMENT SUMMARY FOR BASE SEPOLIA ===");
  console.log(`DAX_Agreement:    ${agreementAddr}`);
  console.log(`DAX_Court:        ${courtAddr}`);
  console.log(`Base Sepolia USDC: ${BASE_SEPOLIA_USDC}`);
  console.log(`Treasury:         ${TREASURY_ADDRESS}`);
  console.log("===========================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
