import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js";
import { setupSandbox, getTestWallet, deployToken, deployAccount, mintTokensPublic } from "./utils.js";
import { AztecToEvmBridge, EvmToAztecBridge } from "./bridge.js";
import { AZTEC_NODE_URL, EVM_RPC_URL, EVM_CHAIN_NAME, SPONSORED_FPC_ADDRESS, IS_PRODUCTION, AZTEC_ENV, logConfig, getViemChain, DEMO_EVM_PRIVATE_KEY, DEMO_EVM_ADDRESS } from "./config.js";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3002;
const FAUCET_AMOUNT = 1000n * 1000000n; // 1000 USDC with 6 decimals

const SERVER_STARTUP_TIMESTAMP = Date.now();

// Try to load EVM token address from deployment file if not set via env
function getEvmTokenAddress(): string | undefined {
  if (process.env.EVM_TOKEN_ADDRESS) {
    return process.env.EVM_TOKEN_ADDRESS;
  }

  const deploymentPath = path.join(__dirname, "../evm-deployment.json");
  try {
    if (fs.existsSync(deploymentPath)) {
      const data = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
      if (data.address) {
        console.log(`[Config] Loaded EVM token address from evm-deployment.json: ${data.address}`);
        return data.address;
      }
    }
  } catch (error) {
    console.log("[Config] Could not read evm-deployment.json:", error);
  }

  return undefined;
}

const EVM_TOKEN_ADDRESS = getEvmTokenAddress();
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

let wallet: EmbeddedWallet;
let token: TokenContract;
let minterAddress: AztecAddress;
let bridge: AztecToEvmBridge | null = null;
let reverseBridge: EvmToAztecBridge | null = null;
let isInitialized = false;
let activeFpcAddress: string = SPONSORED_FPC_ADDRESS;

/**
 * Fund the canonical SponsoredFPC with fee juice by bridging from L1 (Anvil).
 */
async function fundFPCWithFeeJuice(
  node: AztecNode,
  fpcAddress: AztecAddress,
  feePayerAddress: AztecAddress
): Promise<void> {
  const { FeeJuiceContract } = await import('@aztec/aztec.js/protocol');
  const feeJuice = FeeJuiceContract.at(wallet);

  const { result: balance } = await feeJuice.methods.balance_of_public(fpcAddress).simulate({ from: feePayerAddress });
  if (balance > 0n) {
    console.log(`[Server] SponsoredFPC already has ${balance} fee juice, skipping funding`);
    return;
  }

  console.log('[Server] SponsoredFPC has no fee juice, bridging from L1...');
  const { createExtendedL1Client } = await import('@aztec/ethereum/client');
  const { L1FeeJuicePortalManager } = await import('@aztec/aztec.js/ethereum');
  const { createLogger } = await import('@aztec/foundation/log');

  const chain = await getViemChain();
  const l1Client = createExtendedL1Client([EVM_RPC_URL], EVM_PRIVATE_KEY!, chain as any);
  const logger = createLogger('fee-juice-funding');
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, logger);

  const FUND_AMOUNT = 1000n * 10n ** 18n;
  console.log(`[Server] Bridging ${FUND_AMOUNT} fee juice from L1 to FPC...`);
  const claim = await portalManager.bridgeTokensPublic(fpcAddress, FUND_AMOUNT, true);
  console.log(`[Server] Fee juice deposited on L1 (messageLeafIndex: ${claim.messageLeafIndex})`);

  const MAX_RETRIES = 30;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Server] Claiming fee juice on L2 (attempt ${attempt}/${MAX_RETRIES})...`);
      await feeJuice.methods.claim(
        fpcAddress,
        claim.claimAmount,
        claim.claimSecret,
        claim.messageLeafIndex
      ).send({ from: feePayerAddress });

      console.log('[Server] SponsoredFPC funded with fee juice successfully!');
      return;
    } catch (error: any) {
      const msg = error?.message || '';
      if (msg.includes('Message not in state') || msg.includes('not found') || msg.includes('leaf') || msg.includes('nothing to prove')) {
        if (attempt < MAX_RETRIES) {
          console.log(`[Server] L1→L2 message not yet available, waiting... (attempt ${attempt})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
      throw error;
    }
  }

  throw new Error('Failed to claim fee juice after max retries');
}

async function initialize() {
  logConfig();

  console.log(`[Server] Connecting to Aztec at ${AZTEC_NODE_URL}...`);
  const node = await setupSandbox();

  console.log("[Server] Setting up wallet...");
  const result = await getTestWallet(node);
  wallet = result.wallet;

  // Set up SponsoredFPC: derive address from artifact + salt (as per Aztec docs)
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/aztec.js/contracts');
  const { Fr } = await import('@aztec/aztec.js/fields');

  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  const fpcAddr = sponsoredFPCInstance.address;
  activeFpcAddress = fpcAddr.toString();
  console.log(`[Server] SponsoredFPC address derived: ${activeFpcAddress}`);

  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  console.log(`[Server] SponsoredFPC registered with PXE`);

  // On production, FPC is already funded; on localnet, fund from L1
  if (IS_PRODUCTION) {
    console.log('[Server] Production: SponsoredFPC is already funded');
  } else {
    try {
      const feePayerAddress = result.accounts[0];
      await fundFPCWithFeeJuice(node, fpcAddr, feePayerAddress);
    } catch (error) {
      console.error('[Server] Failed to fund SponsoredFPC:', error);
    }
  }

  // Deploy minter account with FPC, then deploy token
  minterAddress = result.accounts[0];

  console.log("[Server] Deploying minter account with SponsoredFPC...");
  try {
    await deployAccount(result.accountManagers[0], activeFpcAddress);
  } catch (deployError: any) {
    if (deployError.message?.includes("already deployed") || deployError.message?.includes("nullifier")) {
      console.log("[Server] Minter account already deployed");
    } else {
      throw deployError;
    }
  }

  console.log("[Server] Deploying new USDC token...");
  token = await deployToken(wallet, minterAddress, "USDC", "USDC", 6, activeFpcAddress);

  console.log(`[Server] Token initialized at ${token.address.toString()}`);
  console.log(`[Server] Minter address: ${minterAddress.toString()}`);

  // Initialize bridge if EVM token address and private key are set
  if (EVM_TOKEN_ADDRESS && EVM_PRIVATE_KEY) {
    console.log("[Server] Initializing Aztec -> EVM bridge...");
    console.log(`  EVM RPC: ${EVM_RPC_URL}`);
    bridge = new AztecToEvmBridge(wallet, token, EVM_TOKEN_ADDRESS, EVM_PRIVATE_KEY, EVM_RPC_URL);
    await bridge.start();
    console.log(`[Server] Bridge initialized with EVM token at ${EVM_TOKEN_ADDRESS}`);

    console.log("[Server] Initializing EVM -> Aztec reverse bridge...");
    reverseBridge = new EvmToAztecBridge(wallet, token, minterAddress, activeFpcAddress, EVM_TOKEN_ADDRESS, EVM_PRIVATE_KEY, EVM_RPC_URL);
    await reverseBridge.start();
    console.log(`[Server] Reverse bridge initialized`);
  } else {
    console.log("[Server] Bridge disabled - set EVM_TOKEN_ADDRESS and EVM_PRIVATE_KEY to enable");
  }

  isInitialized = true;
}

const app = express();
app.use(cors());
app.use(express.json());

// Faucet - mint USDC to any address
app.post("/api/faucet", async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: "Server is still initializing, please wait..." });
  }

  try {
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    const recipient = AztecAddress.fromString(address);

    console.log(`[Faucet] Registering recipient ${address}...`);
    await wallet.registerSender(recipient, 'faucet-recipient');

    console.log(`[Faucet] Minting 1000 USDC (PUBLIC) to ${address}...`);
    await mintTokensPublic(token, minterAddress, recipient, FAUCET_AMOUNT, activeFpcAddress);
    console.log(`[Faucet] Mint complete to ${address}`);

    res.json({
      success: true,
      amount: "1000",
    });
  } catch (error) {
    console.error("Error minting tokens:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to mint tokens: ${errorMessage}` });
  }
});

// Bridge - Initiate Aztec -> EVM bridge
app.post("/api/bridge/initiate", async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: "Server is still initializing, please wait..." });
  }

  if (!bridge) {
    return res.status(503).json({ error: "Bridge is not enabled. Set EVM_TOKEN_ADDRESS env var." });
  }

  try {
    const { evmAddress, senderAddress } = req.body;
    if (!evmAddress) {
      return res.status(400).json({ error: "evmAddress is required" });
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
      return res.status(400).json({ error: "Invalid EVM address format" });
    }

    if (!senderAddress) {
      console.warn(`[Bridge] WARNING: No senderAddress provided - note discovery may fail!`);
    }

    console.log(`[Bridge] Initiating bridge for EVM address ${evmAddress}`);
    const session = await bridge.createSession(evmAddress, senderAddress);

    res.json({
      success: true,
      aztecDepositAddress: session.aztecAddress,
      expiresAt: session.expiresAt,
      message: "Send private USDC to the Aztec address within 5 minutes to bridge to EVM",
    });
  } catch (error) {
    console.error("Error initiating bridge:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to initiate bridge: ${errorMessage}` });
  }
});

// Bridge status
app.get("/api/bridge/status/:aztecAddress", (req, res) => {
  if (!bridge) {
    return res.status(503).json({ error: "Bridge is not enabled" });
  }

  const { aztecAddress } = req.params;
  const session = bridge.getSession(aztecAddress);

  if (!session) {
    return res.json({
      status: "not_found",
      message: "Session not found or expired",
    });
  }

  const now = Date.now();
  if (now > session.expiresAt) {
    return res.json({
      status: "expired",
      message: "Session expired without receiving payment",
    });
  }

  res.json({
    status: "pending",
    evmAddress: session.evmAddress,
    expiresAt: session.expiresAt,
    remainingTime: Math.max(0, session.expiresAt - now),
  });
});

// Reverse Bridge - Initiate EVM -> Aztec bridge
app.post("/api/bridge/evm-to-aztec", async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: "Server is still initializing, please wait..." });
  }

  if (!reverseBridge) {
    return res.status(503).json({ error: "Reverse bridge is not enabled. Set EVM_TOKEN_ADDRESS env var." });
  }

  try {
    const { aztecAddress, amount } = req.body;
    if (!aztecAddress || !amount) {
      return res.status(400).json({ error: "aztecAddress and amount are required" });
    }

    const amountBigInt = BigInt(amount);

    console.log(`[ReverseBridge] Initiating bridge for Aztec address ${aztecAddress}, amount: ${amountBigInt}`);
    const session = reverseBridge.createSession(aztecAddress, amountBigInt);

    res.json({
      success: true,
      sessionId: session.sessionId,
      depositAddress: session.depositAddress,
      expiresAt: session.expiresAt,
      message: `Send ${amountBigInt} bUSDC to ${session.depositAddress} on Anvil within 5 minutes`,
    });
  } catch (error) {
    console.error("Error initiating reverse bridge:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to initiate reverse bridge: ${errorMessage}` });
  }
});

// Reverse bridge status
app.get("/api/bridge/evm-to-aztec/status/:sessionId", (req, res) => {
  if (!reverseBridge) {
    return res.status(503).json({ error: "Reverse bridge is not enabled" });
  }

  const { sessionId } = req.params;
  const session = reverseBridge.getSession(sessionId);

  if (!session) {
    return res.json({
      status: "not_found",
      message: "Session not found or expired",
    });
  }

  res.json({
    status: session.status,
    aztecAddress: session.aztecAddress.toString(),
    amount: session.amount.toString(),
    expiresAt: session.expiresAt,
    remainingTime: Math.max(0, session.expiresAt - Date.now()),
  });
});

// Test endpoint - Transfer private tokens (for bridge testing)
app.post("/api/test/transfer-private", async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: "Server is still initializing, please wait..." });
  }

  try {
    const { to, amount } = req.body;
    if (!to || !amount) {
      return res.status(400).json({ error: "to and amount are required" });
    }

    const recipient = AztecAddress.fromString(to);
    const transferAmount = BigInt(amount);

    console.log(`[Test] Transferring ${transferAmount} USDC privately to ${to}...`);

    const { mintTokensPrivate } = await import("./utils.js");
    await mintTokensPrivate(token, minterAddress, recipient, transferAmount, activeFpcAddress);

    console.log(`[Test] Private transfer complete to ${to}`);

    res.json({
      success: true,
      amount: amount.toString(),
      to,
    });
  } catch (error) {
    console.error("Error in test transfer:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to transfer: ${errorMessage}` });
  }
});

// Faucet - mint USDC privately to any address (for frontend demo)
app.post("/api/faucet/private", async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: "Server is still initializing, please wait..." });
  }

  try {
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({ error: "Address is required" });
    }

    const recipient = AztecAddress.fromString(address);

    console.log(`[Faucet] Registering recipient ${address}...`);
    await wallet.registerSender(recipient, 'faucet-recipient');

    console.log(`[Faucet] Minting 1000 USDC (PRIVATE) to ${address}...`);
    const { mintTokensPrivate } = await import("./utils.js");
    await mintTokensPrivate(token, minterAddress, recipient, FAUCET_AMOUNT, activeFpcAddress);
    console.log(`[Faucet] Private mint complete to ${address}`);

    res.json({
      success: true,
      amount: "1000",
    });
  } catch (error) {
    console.error("Error minting tokens:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to mint tokens: ${errorMessage}` });
  }
});

// Demo - Get EVM balance of demo account
app.get("/api/demo/evm-balance", async (_req, res) => {
  if (!EVM_TOKEN_ADDRESS) {
    return res.status(503).json({ error: "EVM token address not configured" });
  }
  if (!DEMO_EVM_ADDRESS) {
    return res.status(503).json({ error: "Demo EVM account not configured" });
  }

  try {
    const chain = await getViemChain();
    const publicClient = createPublicClient({
      chain,
      transport: http(EVM_RPC_URL),
    });

    const balance = await publicClient.readContract({
      address: EVM_TOKEN_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [DEMO_EVM_ADDRESS as `0x${string}`],
    }) as bigint;

    const formatted = (balance / 1000000n).toString();

    res.json({
      balance: balance.toString(),
      formatted,
      address: DEMO_EVM_ADDRESS,
    });
  } catch (error) {
    console.error("Error getting EVM balance:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to get EVM balance: ${errorMessage}` });
  }
});

// Demo - Transfer bUSDC from demo EVM account to bridge deposit address
app.post("/api/demo/transfer-evm-to-bridge", async (req, res) => {
  if (!EVM_TOKEN_ADDRESS) {
    return res.status(503).json({ error: "EVM token address not configured" });
  }

  if (!reverseBridge) {
    return res.status(503).json({ error: "Reverse bridge is not enabled" });
  }

  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ error: "amount is required" });
    }

    const transferAmount = BigInt(amount);
    const depositAddress = reverseBridge.getDepositAddress();

    if (!depositAddress) {
      return res.status(500).json({ error: "Bridge deposit address not available" });
    }

    console.log(`[Demo] Transferring ${transferAmount} bUSDC from demo account to bridge...`);

    const account = privateKeyToAccount(DEMO_EVM_PRIVATE_KEY!);
    const chain = await getViemChain();
    const publicClient = createPublicClient({
      chain,
      transport: http(EVM_RPC_URL),
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(EVM_RPC_URL),
    });

    const hash = await walletClient.writeContract({
      address: EVM_TOKEN_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [depositAddress as `0x${string}`, transferAmount],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[Demo] EVM transfer complete, tx: ${hash}`);

    res.json({
      success: receipt.status === "success",
      txHash: hash,
    });
  } catch (error) {
    console.error("Error in demo EVM transfer:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to transfer: ${errorMessage}` });
  }
});

// Health check
app.get("/api/health", async (_req, res) => {
  const chain = await getViemChain();
  res.json({
    status: isInitialized ? "ok" : "initializing",
    tokenAddress: isInitialized ? token.address.toString() : null,
    minterAddress: isInitialized ? minterAddress.toString() : null,
    bridgeEnabled: !!bridge,
    evmTokenAddress: EVM_TOKEN_ADDRESS || null,
    sponsoredFpcAddress: activeFpcAddress,
    activeBridgeSessions: bridge?.getActiveSessionsCount() || 0,
    reverseBridgeEnabled: !!reverseBridge,
    reverseBridgeDepositAddress: reverseBridge?.getDepositAddress() || null,
    activeReverseBridgeSessions: reverseBridge?.getActiveSessionsCount() || 0,
    serverStartupTimestamp: SERVER_STARTUP_TIMESTAMP,
    environment: AZTEC_ENV,
    isProduction: IS_PRODUCTION,
    nodeUrl: AZTEC_NODE_URL,
    evmRpcUrl: EVM_RPC_URL,
    evmChainId: chain.id,
    evmChainName: EVM_CHAIN_NAME,
    demoEvmAddress: DEMO_EVM_ADDRESS || null,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
  console.log("[Server] Initializing Aztec connection...");

  initialize()
    .then(() => {
      console.log("[Server] Fully initialized and ready!");
      console.log("Endpoints:");
      console.log("  POST /api/faucet - Get test USDC (public)");
      console.log("  POST /api/faucet/private - Get test USDC (private, for frontend)");
      console.log("  POST /api/bridge/initiate - Start Aztec->EVM bridge");
      console.log("  GET  /api/bridge/status/:aztecAddress - Check bridge status");
      console.log("  POST /api/bridge/evm-to-aztec - Start EVM->Aztec bridge");
      console.log("  GET  /api/bridge/evm-to-aztec/status/:sessionId - Check reverse bridge status");
      console.log("  POST /api/test/transfer-private - Server-side private mint (testing)");
      console.log("  GET  /api/demo/evm-balance - Demo EVM account balance");
      console.log("  POST /api/demo/transfer-evm-to-bridge - Demo EVM transfer to bridge");
      console.log("  GET  /api/health - Server health check");
    })
    .catch((err) => {
      console.error("[Server] Failed to initialize:", err?.message || err);
      if (err?.stack) console.error(err.stack);
      process.exit(1);
    });
});
