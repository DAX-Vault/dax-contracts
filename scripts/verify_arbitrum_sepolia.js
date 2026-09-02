import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const deploymentPath = path.join(process.cwd(), "deployments", "arbitrum_sepolia.json");
  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ ERROR: deployments/arbitrum_sepolia.json not found. Run deployment script first.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  console.log("=================================================");
  console.log("Verifying DAX V2 Contracts on Arbiscan (Arbitrum Sepolia)");
  console.log("=================================================");
  console.log("DAX_Court     :", deployment.courtAddress);
  console.log("DAX_Agreement :", deployment.agreementAddress);

  // 1. Verify DAX_Court
  console.log("\n1. Verifying DAX_Court...");
  try {
    await hre.run("verify:verify", {
      address: deployment.courtAddress,
      constructorArguments: [],
    });
    console.log("✅ DAX_Court verified on Arbiscan!");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("ℹ️ DAX_Court is already verified on Arbiscan.");
    } else {
      console.error("❌ DAX_Court verification failed:", error.message);
    }
  }

  // 2. Verify DAX_Agreement
  console.log("\n2. Verifying DAX_Agreement...");
  try {
    await hre.run("verify:verify", {
      address: deployment.agreementAddress,
      constructorArguments: [deployment.courtAddress, deployment.trustedForwarder],
    });
    console.log("✅ DAX_Agreement verified on Arbiscan!");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("ℹ️ DAX_Agreement is already verified on Arbiscan.");
    } else {
      console.error("❌ DAX_Agreement verification failed:", error.message);
    }
  }

  console.log("\nVerification Process Completed!");
  console.log("=================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
