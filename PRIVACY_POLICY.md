# Privacy Policy for DAXVault

**Last Updated:** September 8, 2026  
**Effective Date:** September 8, 2026  

This Privacy Policy explains how **DAXVault** ("we", "our", or "the App"), a self-custodial decentralized agreement and digital asset management application developed by the **DAX Protocol** community, handles user data.

We believe that privacy and financial sovereignty are fundamental human rights. Our architecture is designed so that **we do not collect, store, transmit, or monetize your personal information or private keys**.

---

## 1. Core Principles: Zero-Knowledge & Self-Custody

- **No Centralized Servers or Databases:** DAXVault does not operate user account databases, backend servers, or centralized custody infrastructure.
- **No Account Registration:** You do not provide your name, email address, phone number, government ID, or physical address to use the App.
- **Self-Custodial Architecture:** Your private keys, seed phrases, and passwords never leave your device. You have exclusive ownership and custody of your cryptographic assets.

---

## 2. Information We Access and How It Is Used

DAXVault accesses only the minimum device capabilities necessary to deliver core decentralized wallet and agreement functionality:

### A. Camera (`android.permission.CAMERA`)
- **Purpose:** Used exclusively to scan QR codes for wallet addresses, transaction requests, and peer-to-peer agreement coordination.
- **Data Handling:** Camera data is processed in real time entirely on your device using on-device optical recognition. No images, video streams, or photographic data are saved to disk or transmitted to any server.

### B. Biometric Authentication (`android.permission.USE_BIOMETRIC`)
- **Purpose:** Enables optional, convenient device unlock (fingerprint or facial recognition) to decrypt your local vault session.
- **Data Handling:** Biometric authentication is handled entirely by your device’s operating system and hardware security module (Android KeyStore / Trusted Execution Environment). The App never has access to your raw biometric data or templates.

### C. Push Notifications (`android.permission.POST_NOTIFICATIONS`)
- **Purpose:** Used to display local system status notifications regarding escrow deposits, peer agreement updates, and resolution deadlines.
- **Data Handling:** Notifications are generated locally or received via decentralized relay networks. We do not track or profile user activity through notification payloads.

### D. Network Access (`android.permission.INTERNET`)
- **Purpose:** Enables direct communication with public decentralized blockchain RPC nodes (such as Arbitrum One) and peer-to-peer agreement signaling relays.
- **Data Handling:** Used solely to query on-chain contract state, fetch gas parameters, and broadcast cryptographically signed transactions that you explicitly authorize.

---

## 3. Cryptographic Keys and Secure Storage

- All cryptographic keys (including 12-word recovery seed phrases, private keys, and local PINs) are generated on your device using cryptographically secure pseudorandom number generators.
- Sensitive credentials are encrypted at rest using hardware-backed device keystores (`EncryptedSharedPreferences` / Android KeyStore).
- **At no time are your private keys, seed phrases, or PINs accessible to us, transmitted over the internet, or backed up to any cloud service by default.**

---

## 4. Public Blockchain Data

When you broadcast a transaction or interact with smart contracts on the Arbitrum blockchain or other distributed networks:
- Transactions, wallet addresses, token amounts, and contract state changes are recorded on a public, immutable distributed ledger.
- This information is public by nature of blockchain technology and is accessible to anyone inspecting the blockchain. We do not control, store, or have the ability to alter or erase public on-chain records.

---

## 5. Third-Party Services and SDKs

To interact with decentralized networks, the App communicates with:
- **Public RPC Endpoints (e.g., Arbitrum Public RPCs):** Standard network requests transmit your IP address to node infrastructure strictly for routing internet traffic. We do not operate tracking services or correlate IP addresses with wallet activity.
- **No Third-Party Trackers:** The App contains **no** third-party analytics SDKs, advertising trackers, behavioral profiling engines, or data brokers.

---

## 6. Data Retention and Deletion

- **Zero Server Retention:** Because we do not store your data on centralized servers, there is no remote user profile or database record to retain.
- **Local Data Deletion:** You have full control over your local data at all times. You can immediately and permanently delete all local keys, preferences, and cached data by:
  1. Opening **Settings > Reset Vault** within the App, or
  2. Clearing the App's storage via your device settings (**Settings > Apps > DAXVault > Clear Storage / Data**), or
  3. Uninstalling the App.

> **Warning:** Deleting your local vault without backing up your 12-word recovery seed phrase will result in permanent loss of access to your assets on the blockchain.

---

## 7. Children's Privacy

DAXVault is not directed to children under the age of 13 (or under 16 in certain jurisdictions), and we do not knowingly collect or solicit personal data from children.

---

## 8. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be reflected with an updated "Effective Date" at the top of this document and will be published directly to our open-source repository at [github.com/DAX-Vault/dax-contracts](https://github.com/DAX-Vault/dax-contracts).

---

## 9. Contact Us

If you have questions, feedback, or concerns regarding this Privacy Policy or our privacy practices, you can contact the team:

- **GitHub Issues:** [https://github.com/DAX-Vault/dax-contracts/issues](https://github.com/DAX-Vault/dax-contracts/issues)
- **Email:** `privacy@daxvault.org`
- **Repository:** [https://github.com/DAX-Vault/dax-contracts](https://github.com/DAX-Vault/dax-contracts)
