import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const address = "0xcF73D11A815a5825A749204f4F6C6AD0844E043f";
  
  // Set up provider for Arbitrum Sepolia
  const provider = new ethers.JsonRpcProvider("https://sepolia.arbitrum.io/rpc");
  
  const balance = await provider.getBalance(address);
  console.log(`Address: ${address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
