import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
const config = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.ankr.com/eth_sepolia",
      accounts,
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://rpc.ankr.com/eth",
      accounts,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts,
    },
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      accounts,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts,
      chainId: 84532,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      optimisticEthereum: process.env.OPTIMISM_API_KEY || "",
      base: process.env.BASESCAN_API_KEY || "",
      polygon: process.env.POLYGONSCAN_API_KEY || "",
    },
  },
  sourcify: {
    enabled: true,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
