import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const p2pAddress = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
  const P2PFactory = await ethers.getContractFactory("DAX_P2P");
  const p2p = await P2PFactory.attach(p2pAddress);

  console.log("=========================================");
  console.log("       🔍 DAX P2P ON-CHAIN DIAGNOSTICS   ");
  console.log("=========================================");

  const tradeCount = await p2p.tradeCount();
  console.log(`Total trades found: ${tradeCount.toString()}`);

  const currentBlock = await ethers.provider.getBlock("latest");
  console.log(`Current Block Timestamp: ${currentBlock.timestamp} (${new Date(currentBlock.timestamp * 1000).toLocaleString()})`);

  for (let i = 1; i <= tradeCount; i++) {
    const t = await p2p.getTrade(i);
    const statusMap = ["PENDING", "PAID", "COMPLETED", "DISPUTED", "CANCELLED"];
    
    console.log(`\n--- Trade #${i} ---`);
    console.log(`Ad ID:            ${t.adId.toString()}`);
    console.log(`Buyer:            ${t.buyer}`);
    console.log(`Seller:           ${t.seller}`);
    console.log(`Token:            ${t.token}`);
    console.log(`Amount:           ${ethers.formatEther(t.amount)}`);
    console.log(`Status:           ${statusMap[t.status] || t.status.toString()}`);
    console.log(`Payment Deadline: ${t.paymentDeadline.toString()} (${new Date(Number(t.paymentDeadline) * 1000).toLocaleString()})`);
    
    const isExpired = currentBlock.timestamp > Number(t.paymentDeadline);
    console.log(`Is Expired:       ${isExpired ? "❌ YES" : "✅ NO"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
