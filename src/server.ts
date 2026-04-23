import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js";
import { setupSandbox, getTestWallet, deployToken, deployAccount } from "./utils.js";
import { AztecToEvmBridge, EvmToAztecBridge } from "./bridge.js";
import { AZTEC_NODE_URL, EVM_RPC_URL, EVM_CHAIN_NAME, SPONSORED_FPC_ADDRESS, IS_PRODUCTION, AZTEC_ENV, logConfig, getViemChain } from "./config.js";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecNode } from "@aztec/aztec.js/node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3002;
const SERVER_STARTUP_TIMESTAMP = Date.now();

// Try to load EVM token address from deployment file if not set via env
function getEvmTokenAddress(): string | undefined {
  if (process.env.EVM_TOKEN_ADDRESS) return process.env.EVM_TOKEN_ADDRESS;

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

/** Fund the canonical SponsoredFPC with fee juice by bridging from L1. */
async function fundFPCWithFeeJuice(
  node: AztecNode,
  fpcAddress: AztecAddress,
  feePayerAddress: AztecAddress,
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
        fpcAddress, claim.claimAmount, claim.claimSecret, claim.messageLeafIndex,
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

  if (EVM_TOKEN_ADDRESS && EVM_PRIVATE_KEY) {
    console.log("[Server] Initializing Aztec -> EVM bridge...");
    console.log(`  EVM RPC: ${EVM_RPC_URL}`);
    bridge = new AztecToEvmBridge(wallet, token, EVM_TOKEN_ADDRESS, EVM_PRIVATE_KEY, EVM_RPC_URL);
    await bridge.start();
    console.log(`[Server] Forward bridge initialized with EVM token at ${EVM_TOKEN_ADDRESS}`);

    console.log("[Server] Initializing EVM -> Aztec reverse bridge...");
    reverseBridge = new EvmToAztecBridge(wallet, token, minterAddress, activeFpcAddress, EVM_TOKEN_ADDRESS, EVM_PRIVATE_KEY, EVM_RPC_URL);
    await reverseBridge.start();
    console.log(`[Server] Reverse bridge initialized; deposit address = ${reverseBridge.getDepositAddress()}`);
  } else {
    console.log("[Server] Bridges disabled - set EVM_TOKEN_ADDRESS and EVM_PRIVATE_KEY to enable");
  }

  isInitialized = true;
}

const app = express();
app.use(cors());
app.use(express.json());

// ---- Endpoint plumbing --------------------------------------------------
// Each endpoint guards on (a) server initialization finished, and some on
// (b) a specific bridge being enabled. `withGuards` centralizes those 503s
// plus the try/catch -> 500 json shape that every handler would otherwise
// repeat.

type Guard = () => { status: number; error: string } | null;

const requireInit: Guard = () =>
  isInitialized ? null : { status: 503, error: "Server is still initializing, please wait..." };
const requireBridge: Guard = () =>
  bridge ? null : { status: 503, error: "Bridge is not enabled. Set EVM_TOKEN_ADDRESS env var." };
const requireReverseBridge: Guard = () =>
  reverseBridge ? null : { status: 503, error: "Reverse bridge is not enabled. Set EVM_TOKEN_ADDRESS env var." };

function withGuards(
  guards: Guard[],
  handler: (req: express.Request, res: express.Response) => void | Promise<void>,
): express.RequestHandler {
  return async (req, res) => {
    for (const g of guards) {
      const err = g();
      if (err) { res.status(err.status).json({ error: err.error }); return; }
    }
    try {
      await handler(req, res);
    } catch (error) {
      console.error(`[${req.method} ${req.path}]`, error);
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  };
}

// ---- Endpoints ---------------------------------------------------------

// Open a forward bridge session targeting any EVM address (typically a
// counterfactual IntentAccount).
app.post("/api/bridge/initiate", withGuards([requireInit, requireBridge], async (req, res) => {
  const { evmAddress, senderAddress } = req.body;
  if (!evmAddress) { res.status(400).json({ error: "evmAddress is required" }); return; }
  if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
    res.status(400).json({ error: "Invalid EVM address format" }); return;
  }
  if (!senderAddress) {
    console.warn(`[Bridge] WARNING: No senderAddress provided - note discovery may fail!`);
  }
  console.log(`[Bridge] Initiating bridge for EVM address ${evmAddress}`);
  const session = await bridge!.createSession(evmAddress, senderAddress);
  res.json({
    success: true,
    aztecDepositAddress: session.aztecAddress,
    expiresAt: session.expiresAt,
    message: "Send private USDC to the Aztec address within 5 minutes to bridge to EVM",
  });
}));

// Poll a forward session by its Aztec deposit address.
app.get("/api/bridge/status/:aztecAddress", withGuards([requireBridge], (req, res) => {
  const session = bridge!.getSession(req.params.aztecAddress as string);
  if (!session) {
    res.json({ status: "not_found", message: "Session not found or expired" }); return;
  }
  const now = Date.now();
  if (now > session.expiresAt) {
    res.json({ status: "expired", message: "Session expired without receiving payment" }); return;
  }
  res.json({
    status: "pending",
    evmAddress: session.evmAddress,
    expiresAt: session.expiresAt,
    remainingTime: Math.max(0, session.expiresAt - now),
  });
}));

// Open a reverse bridge session. Server mints private USDC on Aztec to
// `aztecAddress` once its bridge wallet receives the matching `amount`.
app.post("/api/bridge/evm-to-aztec", withGuards([requireInit, requireReverseBridge], async (req, res) => {
  const { aztecAddress, amount } = req.body;
  if (!aztecAddress || !amount) { res.status(400).json({ error: "aztecAddress and amount are required" }); return; }
  const amountBigInt = BigInt(amount);
  console.log(`[ReverseBridge] Initiating bridge for Aztec address ${aztecAddress}, amount: ${amountBigInt}`);
  const session = reverseBridge!.createSession(aztecAddress, amountBigInt);
  res.json({
    success: true,
    sessionId: session.sessionId,
    depositAddress: session.depositAddress,
    expiresAt: session.expiresAt,
    message: `Send ${amountBigInt} bUSDC to ${session.depositAddress} within 5 minutes`,
  });
}));

// Poll a reverse session by its session id.
app.get("/api/bridge/evm-to-aztec/status/:sessionId", withGuards([requireReverseBridge], (req, res) => {
  const session = reverseBridge!.getSession(req.params.sessionId as string);
  if (!session) {
    res.json({ status: "not_found", message: "Session not found or expired" }); return;
  }
  res.json({
    status: session.status,
    aztecAddress: session.aztecAddress.toString(),
    amount: session.amount.toString(),
    expiresAt: session.expiresAt,
    remainingTime: Math.max(0, session.expiresAt - Date.now()),
  });
}));

// Test helper — mint private USDC directly to an Aztec address. Used by
// test-intent.ts to populate a bridge deposit address; not user-facing.
app.post("/api/test/transfer-private", withGuards([requireInit], async (req, res) => {
  const { to, amount } = req.body;
  if (!to || !amount) { res.status(400).json({ error: "to and amount are required" }); return; }
  const recipient = AztecAddress.fromString(to);
  const transferAmount = BigInt(amount);
  console.log(`[Test] Transferring ${transferAmount} USDC privately to ${to}...`);
  const { mintTokensPrivate } = await import("./utils.js");
  await mintTokensPrivate(token, minterAddress, recipient, transferAmount, activeFpcAddress);
  console.log(`[Test] Private transfer complete to ${to}`);
  res.json({ success: true, amount: amount.toString(), to });
}));

// Health check — exposes the Aztec token, EVM token, and bridge state that
// test-intent.ts reads on startup.
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
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
  console.log("[Server] Initializing Aztec connection...");

  initialize()
    .then(() => {
      console.log("[Server] Fully initialized and ready!");
      console.log("Endpoints:");
      console.log("  POST /api/bridge/initiate                    - Start Aztec->EVM bridge");
      console.log("  GET  /api/bridge/status/:aztecAddress        - Poll Aztec->EVM session status");
      console.log("  POST /api/bridge/evm-to-aztec                - Start EVM->Aztec reverse bridge");
      console.log("  GET  /api/bridge/evm-to-aztec/status/:id     - Poll reverse bridge session");
      console.log("  POST /api/test/transfer-private              - Server-side private mint (test helper)");
      console.log("  GET  /api/health                             - Server health + addresses");
    })
    .catch((err) => {
      console.error("[Server] Failed to initialize:", err?.message || err);
      if (err?.stack) console.error(err.stack);
      process.exit(1);
    });
});
