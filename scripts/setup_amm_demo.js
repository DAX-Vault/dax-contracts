import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  const phoneAddress = "0x9EBC9a11a64a7a9858478BA92435CC126B83f8dA";

  const daxAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const usdtAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
  const usdcAddress = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
  const wethAddress = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
  const ammAddress = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";

  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  
  // 1. Get deployed token contracts
  const daxToken = await MockTokenFactory.attach(daxAddress);
  const usdtToken = await MockTokenFactory.attach(usdtAddress);
  const usdcToken = await MockTokenFactory.attach(usdcAddress);
  const wethToken = await MockTokenFactory.attach(wethAddress);

  // 2. Mint testing tokens to user's phone address
  console.log(`Minting testing tokens to phone address (${phoneAddress})...`);
  await (await daxToken.mint(phoneAddress, ethers.parseEther("1000.0"))).wait();
  await (await usdtToken.mint(phoneAddress, ethers.parseEther("1000.0"))).wait();
  await (await usdcToken.mint(phoneAddress, ethers.parseEther("1000.0"))).wait();
  await (await wethToken.mint(phoneAddress, ethers.parseEther("10.0"))).wait();
  console.log("Tokens minted successfully!");

  // 3. Create pool in the AMM and add DAX/USDT liquidity for fallback
  console.log("Connecting to DAX AMM...");
  const AmmFactory = await ethers.getContractFactory("DAX_AMM");
  const amm = AmmFactory.attach(ammAddress);

  try {
    console.log("Creating DAX-USDT liquidity pool...");
    const createTx = await amm.createPool(daxAddress, usdtAddress);
    await createTx.wait();

    console.log("Approving AMM to spend tokens for initial liquidity...");
    await (await daxToken.approve(ammAddress, ethers.parseEther("50000.0"))).wait();
    await (await usdtToken.approve(ammAddress, ethers.parseEther("50000.0"))).wait();

    console.log("Adding initial liquidity: 10,000 DAX and 10,000 USDT...");
    const addLiqTx = await amm.addLiquidity(
      daxAddress,
      usdtAddress,
      ethers.parseEther("10000.0"),
      ethers.parseEther("10000.0"),
      0,
      Math.floor(Date.now() / 1000) + 600
    );
    await addLiqTx.wait();
    console.log("Liquidity successfully added to AMM!");
  } catch (err) {
    console.log("AMM setup skipped or failed (pool might already exist):", err.message);
  }
  
  console.log("\nSetup complete! Phone wallet is preloaded with tokens!");
  console.log(`DAX:  ${daxAddress}`);
  console.log(`USDT: ${usdtAddress}`);
  console.log(`USDC: ${usdcAddress}`);
  console.log(`WETH: ${wethAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
