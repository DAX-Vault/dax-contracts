import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const address = "0x9EBC9a11a64a7a9858478BA92435CC126B83f8dA";
  const damAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const usdtAddress = "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0";

  const [deployer] = await ethers.getSigners();
  const ethBalance = await ethers.provider.getBalance(address);
  console.log(`Address: ${address}`);
  console.log(`ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  
  try {
    const damToken = MockTokenFactory.attach(damAddress);
    const damBal = await damToken.balanceOf(address);
    console.log(`DAM Balance: ${ethers.formatEther(damBal)} DAM`);
  } catch (e) {
    console.log("Could not fetch DAM balance:", e.message);
  }

  try {
    const usdtToken = MockTokenFactory.attach(usdtAddress);
    const usdtBal = await usdtToken.balanceOf(address);
    console.log(`USDT Balance: ${ethers.formatEther(usdtBal)} USDT`);
  } catch (e) {
    console.log("Could not fetch USDT balance:", e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
