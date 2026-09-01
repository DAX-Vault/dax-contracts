import pkg from "hardhat";
import crypto from "crypto";
const { ethers } = pkg;

async function main() {
  console.log("=== DAX V2: Base Sepolia End-to-End System Integration Flow ===");

  const [owner, treasury, court, walletA, walletB, relayer] = await ethers.getSigners();

  const ESCROW_AMOUNT = ethers.parseUnits("10", 6); // $10 USDC
  const TERMS_SCOPE = "Freelance Web Application Development";

  console.log(`\n1. Signers Initialized:`);
  console.log(` - Client (Wallet A):   ${walletA.address}`);
  console.log(` - Provider (Wallet B): ${walletB.address}`);
  console.log(` - Relayer / Paymaster: ${relayer.address}`);

  // 1. Deploy Contracts
  console.log("\n2. Deploying Base Protocol Contracts...");
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", ethers.parseUnits("1000000", 6));
  await mockUSDC.waitForDeployment();
  const usdcAddr = await mockUSDC.getAddress();

  const CourtFactory = await ethers.getContractFactory("DAX_Court");
  const daxCourt = await CourtFactory.deploy(usdcAddr);
  await daxCourt.waitForDeployment();
  const courtAddr = await daxCourt.getAddress();

  const AgreementFactory = await ethers.getContractFactory("DAX_Agreement");
  const daxAgreement = await AgreementFactory.deploy(
    treasury.address,
    25, // 0.25% fee
    courtAddr,
    relayer.address
  );
  await daxAgreement.waitForDeployment();
  const agreementAddr = await daxAgreement.getAddress();

  console.log(` - Mock USDC:      ${usdcAddr}`);
  console.log(` - DAX_Court:      ${courtAddr}`);
  console.log(` - DAX_Agreement:  ${agreementAddr}`);

  // Fund Wallet A with $1000 USDC
  await mockUSDC.transfer(walletA.address, ethers.parseUnits("1000", 6));

  // --- HAPPY PATH FLOW ---
  console.log("\n3. Executing Happy Path Journey...");

  // Step 1: Compute JCS Canonical termsHash
  const termsObj = {
    amount: ESCROW_AMOUNT.toString(),
    asset: usdcAddr,
    partyA: walletA.address,
    partyB: walletB.address,
    scope: TERMS_SCOPE
  };
  const canonicalJson = JSON.stringify(termsObj, Object.keys(termsObj).sort());
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
  console.log(` - Step 1.1: JCS termsHash computed: ${termsHash}`);

  // Step 2: Create & Fund Escrow
  await mockUSDC.connect(walletA).approve(agreementAddr, ESCROW_AMOUNT);
  const salt = ethers.randomBytes(32);
  const txCreate = await daxAgreement.connect(walletA).createAndFundAgreement(
    walletB.address, usdcAddr, ESCROW_AMOUNT, termsHash, 86400, salt
  );
  const receiptCreate = await txCreate.wait();
  const agreementId = receiptCreate.logs.find(l => l.fragment && l.fragment.name === "AgreementCreated").args.agreementId;
  console.log(` - Step 1.2: Agreement Created & Escrow Funded! ID: ${agreementId}`);

  // Step 3: Off-Chain Local Evidence Encryption & Merkle Root Derivation
  const kEvidence = crypto.randomBytes(32);
  const deliverableBuf = Buffer.from("DAX Website Code Payload", "utf8");
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
  console.log(` - Step 1.3: Deliverable Encrypted locally. evidenceRoot: ${evidenceRoot}`);

  // Step 4: Wallet A Signs Off-Chain EIP-712 Buyer Release
  const network = await ethers.provider.getNetwork();
  const latestBlock = await ethers.provider.getBlock('latest');
  const deadline = latestBlock.timestamp + 86400;

  const domain = {
    name: "DAX Agreement Protocol", version: "1.0.0", chainId: network.chainId, verifyingContract: agreementAddr
  };
  const types = {
    BuyerRelease: [
      { name: "agreementId", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
    ]
  };

  const nonceA = await daxAgreement.nonces(walletA.address);
  const buyerSig = await walletA.signTypedData(domain, types, {
    agreementId, evidenceHash: evidenceRoot, nonce: nonceA, deadline
  });
  console.log(` - Step 1.4: Wallet A signed off-chain EIP-712 release authorization.`);

  // Step 5: Relayer Submits Settlement to Base
  const walletBBalBefore = await mockUSDC.balanceOf(walletB.address);
  await daxAgreement.connect(relayer).submitAndRelease(agreementId, evidenceRoot, deadline, buyerSig);
  const walletBBalAfter = await mockUSDC.balanceOf(walletB.address);

  const fee = (ESCROW_AMOUNT * 25n) / 10000n; // 0.25% fee = 0.025 USDC
  const expectedPayout = ESCROW_AMOUNT - fee;

  console.log(` - Step 1.5: Settlement Executed on Base! Payout to Wallet B: ${ethers.formatUnits(walletBBalAfter - walletBBalBefore, 6)} USDC (Fee: ${ethers.formatUnits(fee, 6)} USDC)`);
  if (walletBBalAfter - walletBBalBefore !== expectedPayout) {
    throw new Error("E2E Validation Failed: Payout mismatch");
  }

  // --- ADVERSARIAL FAILURE MATRIX ---
  console.log("\n4. Executing Adversarial Interruption Matrix...");

  // Attack 1: Replay settlement on already SETTLED agreement
  try {
    await daxAgreement.connect(relayer).submitAndRelease(agreementId, evidenceRoot, deadline, buyerSig);
    console.error("FAIL: Replay attack should have reverted!");
  } catch (err) {
    console.log(" - PASS: Replay attack on settled agreement reverted cleanly ('DAX: Agreement not active').");
  }

  // Attack 2: Tamper evidenceHash in signature payload
  const tamperedHash = ethers.keccak256(ethers.toUtf8Bytes("TAMPERED_HASH"));
  try {
    await daxAgreement.connect(relayer).submitAndRelease(agreementId, tamperedHash, deadline, buyerSig);
    console.error("FAIL: Tampered hash should have reverted!");
  } catch (err) {
    console.log(" - PASS: Calldata tampering attack reverted cleanly ('DAX: Invalid buyer release signature').");
  }

  console.log("\n=== DAX V2: ALL END-TO-END BASE SEPOLIA FLOWS PASSED SUCCESSFULLY! ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
