import fs from "fs";
import path from "path";
import dns from "dns";
import { ethers } from "ethers";
import dotenv from "dotenv";

dns.setDefaultResultOrder("ipv4first");
dotenv.config();

async function waitTx(provider, txResponse, description) {
  console.log(`📡 Broadcasted ${description}: ${txResponse.hash}`);
  let receipt = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      receipt = await provider.getTransactionReceipt(txResponse.hash);
      if (receipt && receipt.status === 1) {
        console.log(`✅ ${description} confirmed in block ${receipt.blockNumber}! Gas used: ${receipt.gasUsed}`);
        return receipt;
      } else if (receipt && receipt.status === 0) {
        throw new Error(`${description} reverted on-chain!`);
      }
    } catch (e) {
      if (e.message && e.message.includes("reverted")) throw e;
    }
  }
  throw new Error(`Timeout waiting for ${description} confirmation (${txResponse.hash})`);
}

async function main() {
  console.log("=========================================================");
  console.log("DAX Protocol Direct Arbitrum One Mainnet Deployment");
  console.log("=========================================================");

  const rpcUrl = "https://arb1.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 42161, { staticNetwork: true });

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("Deployer Wallet Address :", wallet.address);
  const chainId = (await provider.getNetwork()).chainId;
  console.log("Chain ID                :", chainId.toString());

  const balance = await provider.getBalance(wallet.address);
  console.log("Deployer Balance        :", ethers.formatEther(balance), "ETH");

  const treasury = process.env.TREASURY_ADDRESS || wallet.address;
  const platformAuthority = process.env.PLATFORM_AUTHORITY || wallet.address;
  const treasuryFeeBps = 25; // 0.25% protocol escrow fee
  const trustedForwarder = process.env.FORWARDER_ADDRESS || ethers.ZeroAddress;

  // 1. Canonical DAX_Token
  const daxTokenAddress = process.env.DAX_TOKEN_ADDRESS || "0x1296C4b4e0960e9ddf1f84aF931D1258AfEc3918";
  console.log("\n1. Reusing canonical DAX_Token at:", daxTokenAddress);

  // 2. Reuse already-deployed DAX_Court on Arbitrum One
  const courtAddress = "0x8c4B6A0e57a8f140606f5459cc613111b4083447";
  console.log("\n2. Reusing freshly deployed DAX_Court at:", courtAddress);

  // 3. Deploy DAX_Agreement
  console.log("\n3. Deploying updated DAX_Agreement (Deliverable countdown starts upon escrow deposit)...");
  const agreementArtifact = JSON.parse(fs.readFileSync("artifacts/contracts/legacy/DAX_Agreement.sol/DAX_Agreement.json", "utf8"));
  const agreementFactory = new ethers.ContractFactory(agreementArtifact.abi, agreementArtifact.bytecode, wallet);
  const agreementDeployTx = await agreementFactory.getDeployTransaction(
    treasury,
    treasuryFeeBps,
    courtAddress,
    trustedForwarder
  );
  const agreementTx = await wallet.sendTransaction(agreementDeployTx);
  const agreementReceipt = await waitTx(provider, agreementTx, "DAX_Agreement Deployment");
  const agreementAddress = agreementReceipt.contractAddress;
  console.log("✅ DAX_Agreement Address:", agreementAddress);

  // 4. Link Court -> Agreement
  console.log("\n4. Linking Court -> Agreement contract...");
  const courtArtifact = JSON.parse(fs.readFileSync("artifacts/contracts/legacy/DAX_Court.sol/DAX_Court.json", "utf8"));
  const courtContract = new ethers.Contract(courtAddress, courtArtifact.abi, wallet);
  const linkTx = await courtContract.setAgreementContract(agreementAddress);
  await waitTx(provider, linkTx, "Court.setAgreementContract");
  console.log("✅ Court ↔ Agreement linkage permanently finalized!");

  // 5. Deploy DAX_OfferPool
  console.log("\n5. Deploying DAX_OfferPool (Matching & Slicing Vault)...");
  const offerPoolArtifact = JSON.parse(fs.readFileSync("artifacts/contracts/legacy/DAX_OfferPool.sol/DAX_OfferPool.json", "utf8"));
  const offerPoolFactory = new ethers.ContractFactory(offerPoolArtifact.abi, offerPoolArtifact.bytecode, wallet);
  const offerPoolDeployTx = await offerPoolFactory.getDeployTransaction(agreementAddress);
  const offerPoolTx = await wallet.sendTransaction(offerPoolDeployTx);
  const offerPoolReceipt = await waitTx(provider, offerPoolTx, "DAX_OfferPool Deployment");
  const offerPoolAddress = offerPoolReceipt.contractAddress;
  console.log("✅ DAX_OfferPool Address:", offerPoolAddress);

  // 6. Reuse canonical DAX_Swap
  const swapAddress = "0x572492EaD1c3da796E5a412384B1bc66a091915A";
  console.log("\n6. Reusing verified DAX_Swap at:", swapAddress);

  // 7. Save Artifacts
  const deploymentDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentDir)) fs.mkdirSync(deploymentDir, { recursive: true });

  const deploymentData = {
    network: "arbitrum_one",
    chainId: Number(chainId),
    timestamp: new Date().toISOString(),
    deployer: wallet.address,
    daxTokenAddress,
    courtAddress,
    agreementAddress,
    offerPoolAddress,
    swapAddress,
    treasury,
    treasuryFeeBps,
    platformAuthority,
    trustedForwarder,
    explorer: {
      daxToken: `https://arbiscan.io/address/${daxTokenAddress}`,
      court: `https://arbiscan.io/address/${courtAddress}`,
      agreement: `https://arbiscan.io/address/${agreementAddress}`,
      offerPool: `https://arbiscan.io/address/${offerPoolAddress}`,
      swap: `https://arbiscan.io/address/${swapAddress}`,
    },
  };

  const outputPath = path.join(deploymentDir, "arbitrum_one.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));
  console.log("\n=========================================================");
  console.log("✅ Arbitrum One Deployment Artifact Saved to:", outputPath);
  console.log("=========================================================");
  console.log(JSON.stringify(deploymentData, null, 2));
}

main().catch((e) => {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
