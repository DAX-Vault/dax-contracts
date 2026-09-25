import hre from "hardhat";
import fs from "fs";
import path from "path";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("=========================================================");
  console.log("DAX Protocol Canonical Arbitrum One Mainnet Deployment");
  console.log("=========================================================");
  console.log("Deployer Wallet Address :", deployer.address);

  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Connected Chain ID      : ${chainId} (${network.name})`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance        :", hre.ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.error("\n❌ ERROR: Deployer wallet has 0 ETH on Arbitrum One.");
    console.error("Please fund your deployer wallet with Arbitrum One ETH:", deployer.address);
    process.exit(1);
  }

  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const platformAuthority = process.env.PLATFORM_AUTHORITY || deployer.address;
  const treasuryFeeBps = 25; // 0.25% protocol escrow fee
  const trustedForwarder = process.env.FORWARDER_ADDRESS || hre.ethers.ZeroAddress;

  console.log("Treasury Address        :", treasury);
  console.log("Platform Authority      :", platformAuthority);
  console.log("Protocol Escrow Fee     : 0.25% (25 bps)");

  // 1. Canonical DAX_Token
  let daxTokenAddress = process.env.DAX_TOKEN_ADDRESS || "0x1296C4b4e0960e9ddf1f84aF931D1258AfEc3918";
  if (process.env.REDEPLOY_TOKEN === "true" || chainId === 31337) {
    console.log("\n1. Deploying DAX_Token (2,000,000,000 DAX Hard Cap)...");
    const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
    const daxToken = await DAX_Token.deploy(deployer.address);
    await daxToken.waitForDeployment();
    daxTokenAddress = await daxToken.getAddress();
    console.log("✅ DAX_Token (2 Billion) deployed at:", daxTokenAddress);
  } else {
    console.log("\n1. Reusing canonical DAX_Token at:", daxTokenAddress);
  }

  // 2. Deploy DAX_Court (Juror staking strictly with canonical DAX_Token)
  console.log("\n2. Deploying DAX_Court (Canonical Arbitrum Hub)...");
  const DAX_Court = await hre.ethers.getContractFactory("DAX_Court");
  const court = await DAX_Court.deploy(daxTokenAddress, platformAuthority);
  await court.waitForDeployment();
  const courtAddress = await court.getAddress();
  console.log("✅ DAX_Court deployed at:", courtAddress);

  // 3. Deploy DAX_Agreement
  console.log("\n3. Deploying DAX_Agreement...");
  const DAX_Agreement = await hre.ethers.getContractFactory("DAX_Agreement");
  const agreement = await DAX_Agreement.deploy(
    treasury,
    treasuryFeeBps,
    courtAddress,
    trustedForwarder
  );
  await agreement.waitForDeployment();
  const agreementAddress = await agreement.getAddress();
  console.log("✅ DAX_Agreement deployed at:", agreementAddress);

  // 4. Link Court -> Agreement contract
  console.log("\n4. Linking Court -> Agreement contract...");
  const linkTx = await court.setAgreementContract(agreementAddress);
  await linkTx.wait();
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 5. Deploy DAX_OfferPool (Matching & Slicing Vault)
  console.log("\n5. Deploying DAX_OfferPool...");
  const DAX_OfferPool = await hre.ethers.getContractFactory("DAX_OfferPool");
  const offerPool = await DAX_OfferPool.deploy(agreementAddress);
  await offerPool.waitForDeployment();
  const offerPoolAddress = await offerPool.getAddress();
  console.log("✅ DAX_OfferPool deployed at:", offerPoolAddress);

  // 6. Deploy DAX_Swap (Native token swap gate)
  console.log("\n6. Deploying DAX_Swap...");
  const DAX_Swap = await hre.ethers.getContractFactory("DAX_Swap");
  const initialEthRate = hre.ethers.parseEther("2000"); // 1 ETH = 2,000 DAX (at $1.50 DAX & $3,000 ETH)
  const swap = await DAX_Swap.deploy(daxTokenAddress, treasury, initialEthRate);
  await swap.waitForDeployment();
  const swapAddress = await swap.getAddress();
  console.log("✅ DAX_Swap deployed at:", swapAddress);

  // 7. Balance confirmation
  const daxTokenContract = await hre.ethers.getContractAt("DAX_Token", daxTokenAddress);
  const finalDeployerBal = await daxTokenContract.balanceOf(deployer.address);
  console.log("\n7. Final Deployer DAX Token Balance:", hre.ethers.formatEther(finalDeployerBal), "DAX");

  // 8. Save Deployment Metadata
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentData = {
    network: "arbitrum_one",
    chainId,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    daxTokenAddress,
    courtAddress,
    agreementAddress,
    offerPoolAddress,
    swapAddress,
    treasury,
    treasuryFeeBps,
    platformAuthority,
    trustedForwarder,
    explorer: {
      daxToken: `https://arbiscan.io/address/${daxTokenAddress}`,
      court: `https://arbiscan.io/address/${courtAddress}`,
      agreement: `https://arbiscan.io/address/${agreementAddress}`,
      offerPool: `https://arbiscan.io/address/${offerPoolAddress}`,
      swap: `https://arbiscan.io/address/${swapAddress}`,
    },
  };

  const outputPath = path.join(deploymentDir, "arbitrum_one.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log("\n=========================================================");
  console.log("✅ Arbitrum One Deployment Artifact Saved to:", outputPath);
  console.log("=========================================================");
  console.log("\nNext Steps:");
  console.log(`1. Verify contracts on Arbiscan:`);
  console.log(`   npx hardhat verify --network arbitrum ${daxTokenAddress} "${deployer.address}"`);
  console.log(`   npx hardhat verify --network arbitrum ${courtAddress} "${daxTokenAddress}" "${platformAuthority}"`);
  console.log(`2. Update dax-app/lib/config/network_config.dart with these addresses!`);
  console.log("=========================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
