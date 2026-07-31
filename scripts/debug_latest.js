import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const p2pAddress = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

  console.log("=========================================");
  console.log("    🔍 HARDHAT RECENT BLOCK & TX AUDIT    ");
  console.log("=========================================");

  const blockNumber = await ethers.provider.getBlockNumber();
  console.log(`Latest block: ${blockNumber}`);

  const startBlock = Math.max(0, blockNumber - 20);
  for (let i = blockNumber; i >= startBlock; i--) {
    const block = await ethers.provider.getBlock(i);
    if (!block || !block.transactions || block.transactions.length === 0) continue;
    
    console.log(`\n--- Block #${i} (${new Date(block.timestamp * 1000).toLocaleTimeString()}) ---`);
    for (const txHash of block.transactions) {
      console.log(`Tx: ${txHash}`);
      const tx = await ethers.provider.getTransaction(txHash);
      if (tx) {
        console.log(`  From: ${tx.from}`);
        console.log(`  To:   ${tx.to}`);
        console.log(`  Data: ${tx.data.slice(0, 30)}...`);
      }
      
      const receipt = await ethers.provider.getTransactionReceipt(txHash);
      console.log(`  Status: ${receipt.status === 1 ? "✅ SUCCESS" : "❌ REVERTED"}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
