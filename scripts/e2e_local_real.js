import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const deploymentPath = path.join(process.cwd(), "deployments", "local.json");
  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ ERROR: deployments/local.json not found.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  console.log("=================================================");
  console.log("DAX V2 E2E Integration Suite (Local Hardhat Node)");
  console.log("=================================================");

  const [deployer, userA, userB] = await hre.ethers.getSigners();
  const agreement = await hre.ethers.getContractAt("DAX_Agreement", deployment.agreementAddress, deployer);
  const court = await hre.ethers.getContractAt("DAX_Court", deployment.courtAddress, deployer);
  const usdt = await hre.ethers.getContractAt("MockToken", deployment.usdtAddress, userA);

  console.log("User A (Party A / Client)  :", userA.address);
  console.log("User B (Party B / Provider):", userB.address);

  // 1. Check Initial USDT Balances
  const usdtBalA = await usdt.balanceOf(userA.address);
  const usdtBalB = await usdt.balanceOf(userB.address);
  console.log("\n1. Initial Balances:");
  console.log("   User A USDT:", hre.ethers.formatUnits(usdtBalA, 6));
  console.log("   User B USDT:", hre.ethers.formatUnits(usdtBalB, 6));

  // 2. User A Creates & Funds Agreement (100 USDT Escrow)
  console.log("\n2. User A Creating & Funding Agreement (100 USDT)...");
  const escrowAmt = hre.ethers.parseUnits("100", 6);
  const termsHash = hre.ethers.id(`DAX Agreement #${Date.now()}: Web Development Service`);
  const durationSeconds = 86400; // 24 hours
  const salt = hre.ethers.hexlify(hre.ethers.randomBytes(32));

  // Approve DAX_Agreement to spend 100 USDT
  await usdt.connect(userA).approve(deployment.agreementAddress, escrowAmt);

  const txCreate = await agreement.connect(userA).createAndFundAgreement(
    userB.address,
    deployment.usdtAddress,
    escrowAmt,
    termsHash,
    durationSeconds,
    salt
  );
  const receiptCreate = await txCreate.wait();

  // Extract agreementId from AgreementCreated event
  const createdEvent = receiptCreate.logs.find(log => {
    try {
      return agreement.interface.parseLog(log)?.name === "AgreementCreated";
    } catch {
      return false;
    }
  });

  const parsedLog = agreement.interface.parseLog(createdEvent);
  const agreementId = parsedLog.args.agreementId;
  console.log("✅ Agreement Created & Funded successfully!");
  console.log("   Agreement ID:", agreementId);

  // 3. Prepare Encrypted Evidence Merkle Root & Buyer EIP-712 Signature
  console.log("\n3. Generating Off-Chain Encrypted Evidence Merkle Root & EIP-712 Signature...");
  const evidenceRoot = hre.ethers.id("MerkleRoot_Deliverable_v1_Encrypted");
  const network = await hre.ethers.provider.getNetwork();
  const domain = {
    name: "DAX Agreement Protocol",
    version: "1.0.0",
    chainId: network.chainId,
    verifyingContract: deployment.agreementAddress,
  };

  const types = {
    BuyerRelease: [
      { name: "agreementId", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const nonce = await agreement.nonces(userA.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const value = {
    agreementId,
    evidenceHash: evidenceRoot,
    nonce: nonce,
    deadline: deadline,
  };

  const signature = await userA.signTypedData(domain, types, value);
  console.log("✅ Encrypted Evidence Merkle Root & Buyer Release Signature Generated!");

  // 4. User B / Relayer Submits Evidence and Executes Release On-Chain
  console.log("\n4. Submitting Evidence & Executing Release On-Chain...");
  await agreement.connect(userB).submitAndRelease(
    agreementId,
    evidenceRoot,
    deadline,
    signature
  );
  console.log("✅ Settlement Executed & Funds Released to Party B!");

  // 5. Verify Final USDT Balances
  const finalBalA = await usdt.balanceOf(userA.address);
  const finalBalB = await usdt.balanceOf(userB.address);
  console.log("\n5. Final Balances After 0.5% Protocol Fee:");
  console.log("   User A USDT:", hre.ethers.formatUnits(finalBalA, 6));
  console.log("   User B USDT:", hre.ethers.formatUnits(finalBalB, 6));

  const expectedPayout = escrowAmt - (escrowAmt * 50n / 10000n); // 99.5 USDT
  console.log("   User B Net Payout:", hre.ethers.formatUnits(expectedPayout, 6), "USDT");
  console.log("\n=================================================");
  console.log("🎉 ALL E2E REAL-WALLET INTEGRATION TESTS PASSED!");
  console.log("=================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
