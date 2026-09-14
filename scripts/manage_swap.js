import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deploymentPath = path.join(process.cwd(), "deployments", "arbitrum_one.json");

  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ deployments/arbitrum_one.json not found. Deploy first.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const swapAddress = deployment.swapAddress;
  const daxTokenAddress = deployment.daxTokenAddress;

  const DAX_Swap = await hre.ethers.getContractFactory("DAX_Swap");
  const swap = DAX_Swap.attach(swapAddress);

  const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
  const daxToken = DAX_Token.attach(daxTokenAddress);

  const args = process.argv.slice(2);
  // Filter out hardhat flags like --network arbitrum
  const userArgs = args.filter((a) => !a.startsWith("--") && a !== "arbitrum" && a !== "arbitrum_one");
  const command = process.env.CMD || userArgs[0] || "status";
  const envAmount = process.env.AMOUNT;

  console.log("=========================================================");
  console.log("DAX_Swap Liquidity & Rate Management CLI");
  console.log("=========================================================");
  console.log("Connected Network   :", (await hre.ethers.provider.getNetwork()).name);
  console.log("Deployer Wallet     :", deployer.address);
  console.log("DAX_Swap Address    :", swapAddress);
  console.log("DAX_Token Address   :", daxTokenAddress);
  console.log("=========================================================\n");

  if (command === "status") {
    const swapDaxBalance = await daxToken.balanceOf(swapAddress);
    const swapEthBalance = await hre.ethers.provider.getBalance(swapAddress);
    const deployerDaxBalance = await daxToken.balanceOf(deployer.address);
    const deployerEthBalance = await hre.ethers.provider.getBalance(deployer.address);

    const ethRate = await swap.ethRate();
    const exitSpreadBps = await swap.exitSpreadBps();
    const ledger = await swap.deployedLedger();

    console.log("--- SWAP CONTRACT LIQUIDITY ---");
    console.log(`• DAX Liquidity Reserve  : ${hre.ethers.formatEther(swapDaxBalance)} DAX`);
    console.log(`• ETH Redemption Reserve : ${hre.ethers.formatEther(swapEthBalance)} ETH`);
    console.log(`• Current ETH Rate       : 1 ETH = ${hre.ethers.formatEther(ethRate)} DAX`);
    console.log(`• Exit Spread            : ${Number(exitSpreadBps) / 100}% (${exitSpreadBps.toString()} bps)`);
    console.log(`• Deployed Ledger        : ${ledger}`);

    console.log("\n--- DEPLOYER WALLET HOLDINGS ---");
    console.log(`• DAX Token Balance      : ${hre.ethers.formatEther(deployerDaxBalance)} DAX`);
    console.log(`• ETH Gas Balance        : ${hre.ethers.formatEther(deployerEthBalance)} ETH`);
    console.log("\nAvailable Commands:");
    console.log("  npx hardhat run scripts/manage_swap.js --network arbitrum status");
    console.log("  npx hardhat run scripts/manage_swap.js --network arbitrum deposit-dax <amount>");
    console.log("  npx hardhat run scripts/manage_swap.js --network arbitrum withdraw-dax <amount>");
    console.log("  npx hardhat run scripts/manage_swap.js --network arbitrum deposit-eth <amount>");
    console.log("  npx hardhat run scripts/manage_swap.js --network arbitrum set-eth-rate <rate>");
  } else if (command === "deposit-dax") {
    const amountStr = envAmount || userArgs[1];
    if (!amountStr) {
      console.error("❌ Please specify amount of DAX to deposit, e.g.: deposit-dax 10000000 or AMOUNT=10000000");
      process.exit(1);
    }
    const amount = hre.ethers.parseEther(amountStr);
    console.log(`Depositing ${amountStr} DAX into DAX_Swap liquidity reserve...`);
    const tx = await daxToken.transfer(swapAddress, amount);
    await tx.wait();
    console.log(`✅ Successfully transferred ${amountStr} DAX to swap contract!`);
    console.log(`Transaction Hash: ${tx.hash}`);
  } else if (command === "withdraw-dax") {
    const amountStr = userArgs[1];
    if (!amountStr) {
      console.error("❌ Please specify amount of DAX to withdraw, e.g.: withdraw-dax 5000000");
      process.exit(1);
    }
    const amount = hre.ethers.parseEther(amountStr);
    console.log(`Withdrawing ${amountStr} DAX from DAX_Swap back to deployer ledger...`);
    const tx = await swap.withdrawDaxLiquidity(amount);
    await tx.wait();
    console.log(`✅ Successfully withdrawn ${amountStr} DAX from swap contract!`);
    console.log(`Transaction Hash: ${tx.hash}`);
  } else if (command === "deposit-eth") {
    const amountStr = userArgs[1];
    if (!amountStr) {
      console.error("❌ Please specify amount of ETH to deposit, e.g.: deposit-eth 0.05");
      process.exit(1);
    }
    const amount = hre.ethers.parseEther(amountStr);
    console.log(`Depositing ${amountStr} ETH into DAX_Swap redemption reserve...`);
    const tx = await deployer.sendTransaction({
      to: swapAddress,
      value: amount,
    });
    await tx.wait();
    console.log(`✅ Successfully deposited ${amountStr} ETH into swap contract!`);
    console.log(`Transaction Hash: ${tx.hash}`);
  } else if (command === "set-eth-rate") {
    const rateStr = userArgs[1];
    if (!rateStr) {
      console.error("❌ Please specify new ETH rate (DAX per 1 ETH), e.g.: set-eth-rate 2000");
      process.exit(1);
    }
    const newRate = hre.ethers.parseEther(rateStr);
    console.log(`Setting new ETH rate: 1 ETH = ${rateStr} DAX...`);
    const tx = await swap.setEthRate(newRate);
    await tx.wait();
    console.log(`✅ ETH exchange rate updated to ${rateStr} DAX per ETH!`);
    console.log(`Transaction Hash: ${tx.hash}`);
  } else if (command === "set-token-rate") {
    const tokenSymbol = (process.env.TOKEN || userArgs[1] || "USDT").toUpperCase();
    const rateStr = process.env.RATE || userArgs[2] || "1.0";
    const tokenAddress = tokenSymbol === "USDC"
        ? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
        : "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"; // USDT
    const decimals = 6;
    const newRate = hre.ethers.parseEther(rateStr);
    console.log(`Setting rate for ${tokenSymbol} (${tokenAddress}): 1 ${tokenSymbol} = ${rateStr} DAX...`);
    const tx = await swap.setTokenRate(tokenAddress, decimals, newRate);
    await tx.wait();
    console.log(`✅ ${tokenSymbol} exchange rate updated to ${rateStr} DAX per ${tokenSymbol}!`);
    console.log(`Transaction Hash: ${tx.hash}`);
  } else {
    console.error(`❌ Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
