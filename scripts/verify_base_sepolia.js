import pkg from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { run } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const deploymentFilePath = path.join(__dirname, "../deployments/base_sepolia.json");
  if (!fs.existsSync(deploymentFilePath)) {
    throw new Error("No deployment file found at deployments/base_sepolia.json. Please deploy first.");
  }

  const deploymentData = JSON.parse(fs.readFileSync(deploymentFilePath, "utf8"));
  console.log("=== Verifying DAX Contracts on BaseScan ===");
  console.log(`DAX_Court:     ${deploymentData.courtAddress}`);
  console.log(`DAX_Agreement: ${deploymentData.agreementAddress}`);

  console.log("\n1. Verifying DAX_Court...");
  try {
    await run("verify:verify", {
      address: deploymentData.courtAddress,
      constructorArguments: [deploymentData.usdcAddress],
    });
    console.log(" - DAX_Court Verified!");
  } catch (error) {
    console.log(` - DAX_Court Verification Note: ${error.message}`);
  }

  console.log("\n2. Verifying DAX_Agreement...");
  try {
    await run("verify:verify", {
      address: deploymentData.agreementAddress,
      constructorArguments: [
        deploymentData.treasuryAddress,
        25, // 0.25% fee
        deploymentData.courtAddress,
        deploymentData.forwarderAddress,
      ],
    });
    console.log(" - DAX_Agreement Verified!");
  } catch (error) {
    console.log(` - DAX_Agreement Verification Note: ${error.message}`);
  }

  console.log("\n=== Contract Verification Process Complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
