import hre from "hardhat";
import fs from "fs";
import path from "path";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

async function main() {
  const { ethers, upgrades } = hre;
  const [deployer] = await ethers.getSigners();

  console.log("=========================================================");
  console.log("DAX Protocol UUPS Upgradeable Proxy Deployment");
  console.log("=========================================================");
  console.log("Deployer Address       :", deployer.address);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Connected Network      : ${network.name} (Chain ID: ${chainId})`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance       :", ethers.formatEther(balance), "ETH");

  const startBlock = await ethers.provider.getBlockNumber();
  console.log("Deployment Start Block :", startBlock);

  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const platformAuthority = process.env.PLATFORM_AUTHORITY || deployer.address;
  const treasuryFeeBps = 25; // 0.25% protocol fee
  const trustedForwarder = process.env.FORWARDER_ADDRESS || ethers.ZeroAddress;
  const daxTokenAddress =
    process.env.DAX_TOKEN_ADDRESS || "0x1296C4b4e0960e9ddf1f84aF931D1258AfEc3918";

  console.log("Treasury Address       :", treasury);
  console.log("Platform Authority     :", platformAuthority);
  console.log("DAX Token Address      :", daxTokenAddress);

  // 1. Deploy DAX_AgreementUpgradeable Proxy
  console.log("\n1. Deploying DAX_AgreementUpgradeable Proxy (UUPS)...");
  const DAX_AgreementUpgradeable = await ethers.getContractFactory("DAX_AgreementUpgradeable");
  const agreementProxy = await upgrades.deployProxy(
    DAX_AgreementUpgradeable,
    [treasury, treasuryFeeBps, platformAuthority, deployer.address],
    {
      kind: "uups",
      constructorArgs: [trustedForwarder],
    }
  );
  await agreementProxy.waitForDeployment();
  const agreementProxyAddress = await agreementProxy.getAddress();
  const agreementImplAddress = await upgrades.erc1967.getImplementationAddress(agreementProxyAddress);

  console.log("✅ DAX_Agreement Proxy Address  :", agreementProxyAddress);
  console.log("   Initial Implementation       :", agreementImplAddress);

  // 2. Deploy DAX_OfferPoolUpgradeable Proxy
  console.log("\n2. Deploying DAX_OfferPoolUpgradeable Proxy (UUPS)...");
  const DAX_OfferPoolUpgradeable = await ethers.getContractFactory("DAX_OfferPoolUpgradeable");
  const offerPoolProxy = await upgrades.deployProxy(
    DAX_OfferPoolUpgradeable,
    [agreementProxyAddress, deployer.address],
    { kind: "uups" }
  );
  await offerPoolProxy.waitForDeployment();
  const offerPoolProxyAddress = await offerPoolProxy.getAddress();
  const offerPoolImplAddress = await upgrades.erc1967.getImplementationAddress(offerPoolProxyAddress);

  console.log("✅ DAX_OfferPool Proxy Address  :", offerPoolProxyAddress);
  console.log("   Initial Implementation       :", offerPoolImplAddress);

  // 3. Deploy DAX_CourtUpgradeable Proxy
  console.log("\n3. Deploying DAX_CourtUpgradeable Proxy (UUPS)...");
  const DAX_CourtUpgradeable = await ethers.getContractFactory("DAX_CourtUpgradeable");
  const courtProxy = await upgrades.deployProxy(
    DAX_CourtUpgradeable,
    [daxTokenAddress, platformAuthority, agreementProxyAddress, deployer.address],
    { kind: "uups" }
  );
  await courtProxy.waitForDeployment();
  const courtProxyAddress = await courtProxy.getAddress();
  const courtImplAddress = await upgrades.erc1967.getImplementationAddress(courtProxyAddress);

  console.log("✅ DAX_Court Proxy Address      :", courtProxyAddress);
  console.log("   Initial Implementation       :", courtImplAddress);

  // 4. Interlink Court to Agreement
  console.log("\n4. Configuring Protocol Contract References...");
  const setCourtTx = await agreementProxy.setDisputeCourt(courtProxyAddress);
  await setCourtTx.wait();
  console.log("✅ Dispute Court set on Agreement contract");

  const deploymentData = {
    network: network.name,
    chainId,
    deploymentBlock: startBlock,
    timestamp: new Date().toISOString(),
    proxies: {
      agreement: agreementProxyAddress,
      offerPool: offerPoolProxyAddress,
      court: courtProxyAddress,
    },
    implementations: {
      agreement: agreementImplAddress,
      offerPool: offerPoolImplAddress,
      court: courtImplAddress,
    },
    config: {
      treasury,
      platformAuthority,
      treasuryFeeBps,
      daxToken: daxTokenAddress,
      trustedForwarder,
    },
  };

  const outputDir = path.resolve("./deployments");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outPath = path.join(outputDir, `${network.name}_proxy_deployment.json`);
  fs.writeFileSync(outPath, JSON.stringify(deploymentData, null, 2));
  console.log("\n✅ Deployment configuration saved to:", outPath);
  console.log("=========================================================");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exit(1);
});
