import hre from "hardhat";

async function main() {
  console.log("==================================================");
  console.log("SIMULATION: Converting 50M DAX to USDT");
  console.log("==================================================\n");

  const [deployer, user, treasury] = await hre.ethers.getSigners();

  // 1. Deploy DAX Token
  const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
  const dax = await DAX_Token.deploy(deployer.address);
  await dax.waitForDeployment();

  // 2. Deploy DAX_Swap
  const DAX_Swap = await hre.ethers.getContractFactory("DAX_Swap");
  const ethRate = hre.ethers.parseEther("2000"); // 1 ETH = 2000 DAX
  const swap = await DAX_Swap.deploy(await dax.getAddress(), treasury.address, ethRate);
  await swap.waitForDeployment();

  // 3. Deploy Mock USDT (6 decimals)
  const MockToken = await hre.ethers.getContractFactory("MockToken");
  const usdt = await MockToken.deploy("Tether USD", "USDT", hre.ethers.parseUnits("100000000", 6));
  await usdt.waitForDeployment();

  // Rate: Let's test at 1 USDT = 10 DAX ($0.10/DAX) and 1 USDT = 1 DAX ($1.00/DAX)
  const rateConfig = [
    { name: "$0.10 per DAX (1 USDT = 10 DAX)", rate: hre.ethers.parseEther("10") },
    { name: "$1.00 per DAX (1 USDT = 1 DAX)", rate: hre.ethers.parseEther("1") },
  ];

  for (const cfg of rateConfig) {
    console.log(`\n--- Scenario: ${cfg.name} ---`);
    await swap.connect(treasury).setTokenRate(await usdt.getAddress(), 6, cfg.rate);

    const daxAmountIn = hre.ethers.parseEther("50000000"); // 50,000,000 DAX
    const rate = cfg.rate;
    const decimals = 6;
    
    // Formula from DAX_Swap.sol:
    // grossToken = (daxAmountIn * (10 ** decimals)) / rate
    const grossUsdt = (daxAmountIn * (10n ** BigInt(decimals))) / rate;
    const spreadBps = await swap.exitSpreadBps(); // 250 bps = 2.5%
    const spreadUsdt = (grossUsdt * spreadBps) / 10000n;
    const netUsdt = grossUsdt - spreadUsdt;

    console.log(`• DAX Input Amount : ${hre.ethers.formatEther(daxAmountIn)} DAX`);
    console.log(`• Gross USDT Output: ${hre.ethers.formatUnits(grossUsdt, 6)} USDT`);
    console.log(`• Exit Spread (2.5%): ${hre.ethers.formatUnits(spreadUsdt, 6)} USDT (sent to Treasury)`);
    console.log(`• Net USDT to User : ${hre.ethers.formatUnits(netUsdt, 6)} USDT`);

    // Fund user with 50M DAX
    await dax.transfer(user.address, daxAmountIn);
    await dax.connect(user).approve(await swap.getAddress(), daxAmountIn);

    // Test 1: Without funding the swap contract's USDT reserve
    console.log("\nAttempting swap WITHOUT USDT in contract reserve:");
    try {
      await swap.connect(user).swapDaxForToken(await usdt.getAddress(), daxAmountIn, 0);
      console.log("Swap succeeded unexpectedly!");
    } catch (err) {
      console.log(`❌ REVERTED AS EXPECTED: "${err.message.split("'")[1] || err.message.slice(0, 80)}"`);
    }

    // Test 2: WITH funding the swap contract's USDT reserve
    console.log(`\nFunding swap contract reserve with ${hre.ethers.formatUnits(grossUsdt, 6)} USDT...`);
    await usdt.transfer(await swap.getAddress(), grossUsdt);

    const userUsdtBefore = await usdt.balanceOf(user.address);
    const treasuryUsdtBefore = await usdt.balanceOf(treasury.address);

    await swap.connect(user).swapDaxForToken(await usdt.getAddress(), daxAmountIn, netUsdt);

    const userUsdtAfter = await usdt.balanceOf(user.address);
    const treasuryUsdtAfter = await usdt.balanceOf(treasury.address);

    console.log(`✅ SWAP SUCCESSFUL!`);
    console.log(`• User Received    : ${hre.ethers.formatUnits(userUsdtAfter - userUsdtBefore, 6)} USDT`);
    console.log(`• Treasury Fee     : ${hre.ethers.formatUnits(treasuryUsdtAfter - treasuryUsdtBefore, 6)} USDT`);
    console.log(`• Swap Contract DAX: ${hre.ethers.formatEther(await dax.balanceOf(await swap.getAddress()))} DAX`);
  }
}

main().catch(console.error);
