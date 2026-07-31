import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  const tokenAddress = "0xAB1Da50c33D43b27fF96e502cBaC99e8EB378A92";

  // Connect to the deployed DAXToken
  const Token = await ethers.getContractAt("IERC20", tokenAddress);

  // Get balance and symbol
  const balance = await Token.balanceOf(deployer.address);
  
  console.log("\n====================================");
  console.log("Token Address:", tokenAddress);
  console.log("Wallet Address:", deployer.address);
  console.log("DAX Token Balance:", ethers.formatUnits(balance, 18), "DAX");
  console.log("====================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
