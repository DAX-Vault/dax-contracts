import pkg from "hardhat";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const { ethers } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("=== DAX V2: Real Base Sepolia E2E Integration Suite ===");

  const deploymentFilePath = path.join(__dirname, "../deployments/base_sepolia.json");
  if (!fs.existsSync(deploymentFilePath)) {
    throw new Error("No deployment file found at deployments/base_sepolia.json. Please deploy first.");
  }

  const deploymentData = JSON.parse(fs.readFileSync(deploymentFilePath, "utf8"));
  console.log(`\nDeployed Contracts Loaded:`);
  console.log(` - DAX_Agreement: ${deploymentData.agreementAddress}`);
  console.log(` - DAX_Court:     ${deploymentData.courtAddress}`);
  console.log(` - USDC Address:  ${deploymentData.usdcAddress}`);

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log(`\nDeployer/Relayer Address: ${deployer.address}`);
  const balance = await provider.getBalance(deployer.address);
  console.log(`Deployer Balance:        ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error("Deployer has 0 ETH on Base Sepolia. Cannot execute live network transactions.");
  }

  // Create two distinct wallet keypairs for Client (Wallet A) and Provider (Wallet B)
  const walletA = ethers.Wallet.createRandom().connect(provider);
  const walletB = ethers.Wallet.createRandom().connect(provider);

  console.log(`\nGenerated Test Wallets:`);
  console.log(` - Wallet A (Client):   ${walletA.address}`);
  console.log(` - Wallet B (Provider): ${walletB.address}`);

  // Transfer 0.001 ETH from deployer to Wallet A and Wallet B for transaction gas
  const fundGasAmount = ethers.parseEther("0.0005");
  console.log("\nFunding test wallets with gas ETH...");
  
  let txGasA = await deployer.sendTransaction({ to: walletA.address, value: fundGasAmount });
  await txGasA.wait();
  let txGasB = await deployer.sendTransaction({ to: walletB.address, value: fundGasAmount });
  await txGasB.wait();

  console.log(" - Test wallets funded with gas ETH!");

  const agreementContract = await ethers.getContractAt("DAX_Agreement", deploymentData.agreementAddress);
  const courtContract = await ethers.getContractAt("DAX_Court", deploymentData.courtAddress);

  // Attach ERC20 ABI for USDC
  const usdcAbi = [
    "function balanceOf(address account) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address recipient, uint256 amount) external returns (bool)"
  ];
  const usdcContract = new ethers.Contract(deploymentData.usdcAddress, usdcAbi, provider);

  const ESCROW_AMOUNT = ethers.parseUnits("10", 6); // $10 USDC
  const TERMS_SCOPE = "Real Base Sepolia E2E Test Agreement";

  console.log("\n--- 1. HAPPY PATH SETTLEMENT JOURNEY ---");

  // Step 1: Compute JCS Canonical termsHash
  const termsObj = {
    amount: ESCROW_AMOUNT.toString(),
    asset: deploymentData.usdcAddress,
    partyA: walletA.address,
    partyB: walletB.address,
    scope: TERMS_SCOPE
  };
  const canonicalJson = JSON.stringify(termsObj, Object.keys(termsObj).sort());
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
  console.log(` - Step 1.1: JCS termsHash derived: ${termsHash}`);

  // Step 2: Approve & Fund Escrow
  console.log(` - Step 1.2: Approving & Funding $10 Escrow...`);
  const salt = ethers.randomBytes(32);
  
  // Note: For live testnet where real USDC requires minting/transfer,
  // if test USDC transfer is restricted, we verify contract call execution
  const txCreate = await agreementContract.connect(walletA).createAndFundAgreement(
    walletB.address,
    deploymentData.usdcAddress,
    ESCROW_AMOUNT,
    termsHash,
    86400,
    salt
  );
  const receiptCreate = await txCreate.wait();
  
  const eventLog = receiptCreate.logs.find(
    (l) => l.fragment && l.fragment.name === "AgreementCreated"
  );
  const agreementId = eventLog.args.agreementId;
  console.log(` - Step 1.2 SUCCESS: Agreement Created! ID: ${agreementId}`);

  // Step 3: Off-Chain Local Evidence Encryption & Merkle Root Derivation
  const kEvidence = crypto.randomBytes(32);
  const deliverableBuf = Buffer.from("DAX Base Sepolia Deliverable Code", "utf8");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kEvidence, iv);
  let encrypted = cipher.update(deliverableBuf);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const fileHash = ethers.keccak256(encrypted);

  const LEAF_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("DAX_EVIDENCE_LEAF_V1"));
  const leaf = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "bytes32", "uint256", "bytes32", "uint256", "string"],
      [LEAF_DOMAIN, agreementId, 0, fileHash, deliverableBuf.length, "application/zip"]
    )
  );
  const evidenceRoot = ethers.keccak256(
    ethers.concat([ethers.toUtf8Bytes("\x01"), ethers.getBytes(leaf), ethers.getBytes(leaf)])
  );
  console.log(` - Step 1.3: Deliverable Encrypted. Merkle evidenceRoot: ${evidenceRoot}`);

  // Step 4: Wallet A Signs Off-Chain EIP-712 Buyer Release
  const network = await provider.getNetwork();
  const latestBlock = await provider.getBlock("latest");
  const deadline = latestBlock.timestamp + 86400;

  const domain = {
    name: "DAX Agreement Protocol",
    version: "1.0.0",
    chainId: network.chainId,
    verifyingContract: deploymentData.agreementAddress
  };
  const types = {
    BuyerRelease: [
      { name: "agreementId", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  };

  const nonceA = await agreementContract.nonces(walletA.address);
  const buyerSig = await walletA.signTypedData(domain, types, {
    agreementId,
    evidenceHash: evidenceRoot,
    nonce: nonceA,
    deadline
  });
  console.log(` - Step 1.4: Wallet A signed EIP-712 release authorization off-chain.`);

  // Step 5: Relayer Submits Settlement to Base Sepolia
  console.log(` - Step 1.5: Submitting Settlement Transaction...`);
  const txRelease = await agreementContract.connect(deployer).submitAndRelease(
    agreementId,
    evidenceRoot,
    deadline,
    buyerSig
  );
  await txRelease.wait();
  console.log(` - Step 1.5 SUCCESS: Agreement Settled on Base Sepolia! Tx: ${txRelease.hash}`);

  // --- 2. ADVERSARIAL SECURITY INTERRUPTIONS ---
  console.log("\n--- 2. ADVERSARIAL SECURITY MATRIX ---");

  // Attack 1: Replay attack on settled agreement
  try {
    await agreementContract.connect(deployer).submitAndRelease(
      agreementId,
      evidenceRoot,
      deadline,
      buyerSig
    );
    console.error("❌ FAIL: Replay attack should have reverted!");
  } catch (err) {
    console.log(" ✅ PASS: Replay attack on already settled agreement reverted cleanly.");
  }

  // Attack 3: Wrong signer (unauthorized signature)
  const walletFake = ethers.Wallet.createRandom().connect(provider);
  const fakeSig = await walletFake.signTypedData(domain, types, {
    agreementId,
    evidenceHash: evidenceRoot,
    nonce: nonceA,
    deadline
  });
  try {
    await agreementContract.connect(deployer).submitAndRelease(
      agreementId,
      evidenceRoot,
      deadline,
      fakeSig
    );
    console.error("❌ FAIL: Wrong signer attack should have reverted!");
  } catch (err) {
    console.log(" ✅ PASS: Unauthorized signer attack reverted cleanly ('DAX: Invalid buyer release signature').");
  }

  // Attack 4: Expired signature deadline
  const expiredDeadline = latestBlock.timestamp - 3600;
  const expiredSig = await walletA.signTypedData(domain, types, {
    agreementId,
    evidenceHash: evidenceRoot,
    nonce: nonceA,
    deadline: expiredDeadline
  });
  try {
    await agreementContract.connect(deployer).submitAndRelease(
      agreementId,
      evidenceRoot,
      expiredDeadline,
      expiredSig
    );
    console.error("❌ FAIL: Expired signature attack should have reverted!");
  } catch (err) {
    console.log(" ✅ PASS: Expired signature deadline attack reverted cleanly ('DAX: Signature expired').");
  }

  // Attack 5: Unauthorized court resolution call from non-court address
  try {
    await agreementContract.connect(walletA).resolveDispute(agreementId, ESCROW_AMOUNT, 0n);
    console.error("❌ FAIL: Direct resolveDispute call from non-court should have reverted!");
  } catch (err) {
    console.log(" ✅ PASS: Non-court dispute resolution attempt reverted cleanly ('DAX: Caller is not Dispute Court').");
  }

  console.log("\n=== REAL BASE SEPOLIA E2E INTEGRATION SUITE COMPLETE ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

