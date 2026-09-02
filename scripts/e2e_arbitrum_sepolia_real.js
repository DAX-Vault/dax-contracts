import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const deploymentPath = path.join(process.cwd(), "deployments", "arbitrum_sepolia.json");
  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ ERROR: deployments/arbitrum_sepolia.json not found. Deploy to Arbitrum Sepolia first.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  console.log("=================================================");
  console.log("DAX V2 Live E2E Integration Suite (Arbitrum Sepolia)");
  console.log("=================================================");
  console.log("Target Court     :", deployment.courtAddress);
  console.log("Target Agreement :", deployment.agreementAddress);

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer Wallet  :", deployer.address);
  console.log("Deployer ETH     :", hre.ethers.formatEther(balance));

  const agreement = await hre.ethers.getContractAt("DAX_Agreement", deployment.agreementAddress, deployer);
  const court = await hre.ethers.getContractAt("DAX_Court", deployment.courtAddress, deployer);

  const linkedCourt = await agreement.courtContract();
  console.log("Agreement -> Linked Court:", linkedCourt);
  if (linkedCourt.toLowerCase() !== deployment.courtAddress.toLowerCase()) {
    throw new Error("❌ Mismatch between agreement linked court and deployment court address!");
  }

  console.log("✅ Court-Agreement Linkage Verified Live on Arbitrum Sepolia!");
  console.log("=================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
