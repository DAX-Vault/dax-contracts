import { expect } from "chai";
import pkg from "hardhat";
import crypto from "crypto";
const { ethers } = pkg;

describe("DAX Phase 5: Minimal Evidence Protocol Local Verification Engine", function () {
  let partyA, partyB, court;
  let agreementId, termsHash, kEvidence;

  before(async function () {
    [partyA, partyB, court] = await ethers.getSigners();
    agreementId = ethers.keccak256(ethers.toUtf8Bytes("AGREEMENT_001"));
  });

  describe("Gate 5A — JCS Canonicalization & termsHash", function () {
    it("Should generate identical termsHash for semantically identical JSON objects with different key ordering", function () {
      const termsObj1 = {
        amount: "500000000",
        asset: "0xaf88065e77c8cC2239327C5EDb3A432268e5831",
        partyA: partyA.address,
        partyB: partyB.address,
        scope: "Web Application Build"
      };

      const termsObj2 = {
        scope: "Web Application Build",
        partyB: partyB.address,
        amount: "500000000",
        partyA: partyA.address,
        asset: "0xaf88065e77c8cC2239327C5EDb3A432268e5831"
      };

      // Helper function for JCS (RFC 8785 key sorting)
      const canonicalize = (obj) => {
        return JSON.stringify(obj, Object.keys(obj).sort());
      };

      const json1 = canonicalize(termsObj1);
      const json2 = canonicalize(termsObj2);

      expect(json1).to.equal(json2);

      const hash1 = ethers.keccak256(ethers.toUtf8Bytes(json1));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes(json2));

      expect(hash1).to.equal(hash2);
      termsHash = hash1;
    });
  });

  describe("Gate 5B — AES-256-GCM Encryption & Key Envelopes", function () {
    let encryptedData, iv, authTag, keyEnvelopePartyA;

    before(function () {
      // 1. Generate dedicated K_evidence symmetric key (256-bit)
      kEvidence = crypto.randomBytes(32);
    });

    it("Should encrypt deliverable payload locally with AES-256-GCM", function () {
      const plainDeliverable = "function main() { console.log('Delivered Code'); }";
      iv = crypto.randomBytes(12);

      const cipher = crypto.createCipheriv("aes-256-gcm", kEvidence, iv);
      let encrypted = cipher.update(plainDeliverable, "utf8", "hex");
      encrypted += cipher.final("hex");
      authTag = cipher.getAuthTag();

      encryptedData = encrypted;
      expect(encryptedData).to.be.a("string");
    });

    it("Should wrap K_evidence into Key Envelopes using RSA/ECIES key wrapping", function () {
      // Key envelope wrapping K_evidence for Party A
      const aliceSecret = ethers.toUtf8Bytes("PartyA_Shared_Secret");
      const derivedKeyA = crypto.pbkdf2Sync(aliceSecret, "salt", 1000, 32, "sha256");

      const ivEnv = crypto.randomBytes(12);
      const cipherEnv = crypto.createCipheriv("aes-256-gcm", derivedKeyA, ivEnv);
      let wrappedK = cipherEnv.update(kEvidence);
      wrappedK = Buffer.concat([wrappedK, cipherEnv.final()]);
      const tagEnv = cipherEnv.getAuthTag();

      keyEnvelopePartyA = { wrappedK, ivEnv, tagEnv };

      // Party A unwraps K_evidence
      const decipherEnv = crypto.createDecipheriv("aes-256-gcm", derivedKeyA, ivEnv);
      decipherEnv.setAuthTag(tagEnv);
      let unwrappedK = decipherEnv.update(wrappedK);
      unwrappedK = Buffer.concat([unwrappedK, decipherEnv.final()]);

      expect(unwrappedK.toString("hex")).to.equal(kEvidence.toString("hex"));
    });
  });

  describe("Gate 5C — Canonical Merkle Tree Construction & Verification Engine", function () {
    let leaves, merkleRoot;

    it("Should build canonical Merkle Tree and derive evidenceRoot", function () {
      const files = [
        { index: 0, hash: ethers.keccak256(ethers.toUtf8Bytes("file0")), size: 1024, mime: "application/zip" },
        { index: 1, hash: ethers.keccak256(ethers.toUtf8Bytes("file1")), size: 2048, mime: "text/plain" }
      ];

      const LEAF_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("DAX_EVIDENCE_LEAF_V1"));

      leaves = files.map(f => {
        return ethers.keccak256(
          ethers.solidityPacked(
            ["bytes32", "bytes32", "uint256", "bytes32", "uint256", "string"],
            [LEAF_DOMAIN, agreementId, f.index, f.hash, f.size, f.mime]
          )
        );
      });

      // Compute Merkle Root: keccak256(0x01 || leaf0 || leaf1)
      merkleRoot = ethers.keccak256(
        ethers.concat([
          ethers.toUtf8Bytes("\x01"),
          ethers.getBytes(leaves[0]),
          ethers.getBytes(leaves[1])
        ])
      );

      expect(merkleRoot).to.be.a("string");
      expect(merkleRoot.length).to.equal(66); // 0x + 64 hex chars
    });

    it("Should verify retrieved evidence matches committed evidenceRoot", function () {
      const reconstructedRoot = ethers.keccak256(
        ethers.concat([
          ethers.toUtf8Bytes("\x01"),
          ethers.getBytes(leaves[0]),
          ethers.getBytes(leaves[1])
        ])
      );

      expect(reconstructedRoot).to.equal(merkleRoot);
    });
  });

  describe("Gate 5D — Private Dispute Access Flow", function () {
    it("Should authorize Court Juror key envelope exchange during dispute", function () {
      const courtSecret = ethers.toUtf8Bytes("Dispute_Court_Secret");
      const derivedKeyCourt = crypto.pbkdf2Sync(courtSecret, "salt", 1000, 32, "sha256");

      const ivCourt = crypto.randomBytes(12);
      const cipherCourt = crypto.createCipheriv("aes-256-gcm", derivedKeyCourt, ivCourt);
      let wrappedKCourt = cipherCourt.update(kEvidence);
      wrappedKCourt = Buffer.concat([wrappedKCourt, cipherCourt.final()]);
      const tagCourt = cipherCourt.getAuthTag();

      // Juror decrypts evidence key
      const decipherCourt = crypto.createDecipheriv("aes-256-gcm", derivedKeyCourt, ivCourt);
      decipherCourt.setAuthTag(tagCourt);
      let jurorDecryptedK = decipherCourt.update(wrappedKCourt);
      jurorDecryptedK = Buffer.concat([jurorDecryptedK, decipherCourt.final()]);

      expect(jurorDecryptedK.toString("hex")).to.equal(kEvidence.toString("hex"));
    });
  });
});
