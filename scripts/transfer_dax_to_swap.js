import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deploymentPath = path.join(process.cwd(), "deployments", "arbitrum_one.json");

  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ deployments/arbitrum_one.json not found.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const swapAddress = deployment.swapAddress;
  const daxTokenAddress = deployment.daxTokenAddress;

  const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
  const daxToken = DAX_Token.attach(daxTokenAddress);

  // Amount in full DAX units (e.g. "10000000" for 10M DAX, or from process.env.AMOUNT)
  const amountStr = process.env.AMOUNT || "10000000";
  const amountWei = hre.ethers.parseEther(amountStr);

  console.log("=========================================================");
  console.log("Transfer DAX Liquidity from Deployer/Ledger to DAX_Swap");
  console.log("=========================================================");
  console.log("Network             :", (await hre.ethers.provider.getNetwork()).name);
  console.log("Deployer (Ledger)   :", deployer.address);
  console.log("DAX_Token Address   :", daxTokenAddress);
  console.log("DAX_Swap Address    :", swapAddress);
  console.log("Transfer Amount     :", amountStr, "DAX");

  const initialDeployerBal = await daxToken.balanceOf(deployer.address);
  const initialSwapBal = await daxToken.balanceOf(swapAddress);

  console.log(`• Deployer Balance Before : ${hre.ethers.formatEther(initialDeployerBal)} DAX`);
  console.log(`• DAX_Swap Balance Before : ${hre.ethers.formatEther(initialSwapBal)} DAX`);

  if (initialDeployerBal < amountWei) {
    console.error("\n❌ ERROR: Insufficient DAX balance in deployer wallet.");
    process.exit(1);
  }

  console.log(`\nBroadcasting transfer transaction on Arbitrum One...`);
  const tx = await daxToken.transfer(swapAddress, amountWei);
  console.log(`Transaction broadcast! Hash: ${tx.hash}`);
  console.log(`Waiting for block confirmation...`);
  const receipt = await tx.wait();

  const finalDeployerBal = await daxToken.balanceOf(deployer.address);
  const finalSwapBal = await daxToken.balanceOf(swapAddress);

  console.log("\n=========================================================");
  console.log("✅ TRANSFER SUCCESSFUL!");
  console.log("=========================================================");
  console.log(`• Block Number           : ${receipt.blockNumber}`);
  console.log(`• Gas Used               : ${receipt.gasUsed.toString()}`);
  console.log(`• Deployer Balance After : ${hre.ethers.formatEther(finalDeployerBal)} DAX`);
  console.log(`• DAX_Swap Reserve After : ${hre.ethers.formatEther(finalSwapBal)} DAX`);
  console.log(`• Arbiscan Link          : https://arbiscan.io/tx/${tx.hash}`);
  console.log("=========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
