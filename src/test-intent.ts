/**
 * End-to-end integration test for the intent executor.
 *
 * Runs two sessions against a live anvil + Aztec sandbox + bridge server:
 *   1. primitives on one intent account (transfer, replay-revert, swap,
 *      bUSDC-vault deposit/withdraw)
 *   2. full privacy roundtrip on a fresh intent account — Aztec -> EVM ->
 *      swap -> lend -> unwind -> reverse bridge -> Aztec, three nullifiers
 *      one reusable account
 *
 * Prereqs + invocation: see README.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import "dotenv/config";

import {
  ACCOUNT_ABI,
  FOUNDRY_CHAIN_ID,
  createBackend,
  deployAndExecuteBatch,
  generateCredential,
  localPublicClient,
  proveBatch,
  swapAndSendFlow,
  transferFlow,
  vaultDepositFlow,
  vaultWithdrawFlow,
  type Call,
  type Credential,
  type BatchBackend,
} from "./intent-client.js";
import { BridgeClient } from "./bridge-client.js";

const SERVER_URL = "http://localhost:3001";
const EVM_RPC_URL = "http://localhost:8545";
const BRIDGE_AMOUNT_USDC = 100n;

// Anvil default account #0 is the bridge operator / test caller.
// Account #1 is used as the external EVM recipient (swap output, roundtrip EOA).
const BRIDGE_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXTERNAL_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;

const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

interface IntentDeployment {
  verifier: Hex;
  implementation: Hex;
  factory: Hex;
}

interface MocksDeployment {
  weth: Hex;
  swapRouter: Hex;
  usdcVault: Hex;
  wethVault: Hex;
}

function section(title: string) {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}

function log(msg: string) {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${ts}] ${msg}`);
}

function readIntentDeployment(): IntentDeployment {
  return JSON.parse(readFileSync(resolve(process.cwd(), "intent-deployment.json"), "utf8"));
}

function readMocksDeployment(): MocksDeployment {
  return JSON.parse(readFileSync(resolve(process.cwd(), "mocks-deployment.json"), "utf8"));
}

async function balanceOf(pc: PublicClient, token: Hex, owner: Hex): Promise<bigint> {
  return (await pc.readContract({
    address: token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/** Build proof → submit → wait for receipt. */
async function runBatch(params: {
  label: string;
  backend: BatchBackend;
  credential: Credential;
  calls: Call[];
  nullifier: Hex;
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: PublicClient;
  factory: Hex;
}): Promise<void> {
  log(`[${params.label}] proving batch of ${params.calls.length} call(s)...`);
  const { proof, actionHash } = await proveBatch({
    backend: params.backend,
    credential: params.credential,
    calls: params.calls,
    nullifier: params.nullifier,
    chainId: FOUNDRY_CHAIN_ID,
  });
  log(`[${params.label}] action hash: ${actionHash}`);

  log(`[${params.label}] submitting deployAndExecuteBatch...`);
  const hash = await deployAndExecuteBatch({
    walletClient: params.walletClient,
    factory: params.factory,
    credential: params.credential,
    calls: params.calls,
    nullifier: params.nullifier,
    proof,
  });
  const receipt = await params.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`[${params.label}] tx reverted`);
  log(`[${params.label}] mined at block ${receipt.blockNumber}`);
}

async function main() {
  section("INTENT EXECUTOR INTEGRATION TEST");

  const bridge = new BridgeClient(SERVER_URL);
  const health = await bridge.health();
  const intentD = readIntentDeployment();
  const mocks = readMocksDeployment();
  log(`bUSDC:                ${health.evmTokenAddress}`);
  log(`IntentFactory:        ${intentD.factory}`);
  log(`MockWETH:             ${mocks.weth}`);
  log(`MockSwapRouter:       ${mocks.swapRouter}`);
  log(`MockLendingVault U:   ${mocks.usdcVault}`);
  log(`MockLendingVault W:   ${mocks.wethVault}`);

  const publicClient = localPublicClient(EVM_RPC_URL);
  const walletClient = createWalletClient({
    account: privateKeyToAccount(BRIDGE_PRIVATE_KEY),
    chain: foundry,
    transport: http(EVM_RPC_URL),
  });

  section("Initialize UltraHonk backend");
  const backend = await createBackend();
  log("Barretenberg + UltraHonkBackend ready");

  // First credential runs scenarios A through D.
  section("Generate credential #1 (used for A–D)");
  const cred1 = await generateCredential(publicClient, intentD.factory);
  log(`preimage: ${cred1.preimage.toString()}`);
  log(`salt:     ${cred1.salt.toString()}`);
  log(`intent:   ${cred1.intentAddress}`);

  section("Bridge bUSDC from Aztec to intent #1");
  const bridgeAmount = parseUnits(BRIDGE_AMOUNT_USDC.toString(), 6);
  await bridge.bridgeToEvm({
    evmAddress: cred1.intentAddress,
    amountMicro: bridgeAmount,
    onProgress: log,
  });
  const intentBal0 = await balanceOf(publicClient, health.evmTokenAddress, cred1.intentAddress);
  log(`intent bUSDC after bridge: ${formatUnits(intentBal0, 6)}`);
  if (intentBal0 !== bridgeAmount) throw new Error(`bridge produced ${intentBal0}, expected ${bridgeAmount}`);

  // ---- A: simple transfer -------------------------------------------------
  section("A. Transfer — 40 bUSDC to external recipient");
  const nullifierA = ("0x" + "00".repeat(31) + "0a") as Hex;
  const amountA = parseUnits("40", 6);
  const extRecipBefore = await balanceOf(publicClient, health.evmTokenAddress, EXTERNAL_RECIPIENT);

  await runBatch({
    label: "transfer",
    backend,
    credential: cred1,
    calls: transferFlow(health.evmTokenAddress, EXTERNAL_RECIPIENT, amountA),
    nullifier: nullifierA,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const extRecipAfterA = await balanceOf(publicClient, health.evmTokenAddress, EXTERNAL_RECIPIENT);
  const intentBal1 = await balanceOf(publicClient, health.evmTokenAddress, cred1.intentAddress);
  if (extRecipAfterA - extRecipBefore !== amountA) throw new Error("transfer recipient delta wrong");
  if (intentBal1 !== intentBal0 - amountA) throw new Error("intent balance after transfer wrong");
  log(`✓ external recipient +${formatUnits(amountA, 6)} bUSDC; intent ${formatUnits(intentBal1, 6)}`);

  // ---- A': replay revert --------------------------------------------------
  section("A'. Replay transfer — expect Replay revert");
  const replayCalls = transferFlow(health.evmTokenAddress, EXTERNAL_RECIPIENT, amountA);
  const { proof: replayProof } = await proveBatch({
    backend,
    credential: cred1,
    calls: replayCalls,
    nullifier: nullifierA,
    chainId: FOUNDRY_CHAIN_ID,
  });
  try {
    await publicClient.simulateContract({
      account: walletClient.account!,
      address: cred1.intentAddress,
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        replayCalls,
        nullifierA,
        ("0x" + Buffer.from(replayProof.proof).toString("hex")) as Hex,
      ],
    });
    throw new Error("expected replay to revert");
  } catch (err: any) {
    if (err.message === "expected replay to revert") throw err;
    log(`✓ replay reverted: ${err.shortMessage ?? err.message}`);
  }

  // ---- B: swap-and-send ---------------------------------------------------
  section("B. Swap-and-send — 30 bUSDC -> WETH to external recipient");
  const nullifierB = ("0x" + "00".repeat(31) + "0b") as Hex;
  const amountInB = parseUnits("30", 6);
  const minOutB = parseUnits("29", 18);
  const wethBefore = await balanceOf(publicClient, mocks.weth, EXTERNAL_RECIPIENT);

  await runBatch({
    label: "swap",
    backend,
    credential: cred1,
    calls: swapAndSendFlow({
      router: mocks.swapRouter,
      tokenIn: health.evmTokenAddress,
      tokenOut: mocks.weth,
      amountIn: amountInB,
      minAmountOut: minOutB,
      recipient: EXTERNAL_RECIPIENT,
    }),
    nullifier: nullifierB,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const wethAfter = await balanceOf(publicClient, mocks.weth, EXTERNAL_RECIPIENT);
  const intentBal2 = await balanceOf(publicClient, health.evmTokenAddress, cred1.intentAddress);
  const expectedOut = (amountInB * 10n ** 18n) / 10n ** 6n;
  if (wethAfter - wethBefore !== expectedOut) {
    throw new Error(`swap output mismatch: got ${wethAfter - wethBefore}, expected ${expectedOut}`);
  }
  if (intentBal2 !== intentBal1 - amountInB) throw new Error("intent bUSDC after swap wrong");
  log(`✓ external recipient +${formatUnits(expectedOut, 18)} WETH; intent ${formatUnits(intentBal2, 6)} bUSDC`);

  // ---- C: vault deposit (bUSDC vault) ------------------------------------
  section("C. Vault deposit — 20 bUSDC into bUSDC vault");
  const nullifierC = ("0x" + "00".repeat(31) + "0c") as Hex;
  const depositAmount = parseUnits("20", 6);

  await runBatch({
    label: "vault-deposit",
    backend,
    credential: cred1,
    calls: vaultDepositFlow({
      vault: mocks.usdcVault,
      asset: health.evmTokenAddress,
      amount: depositAmount,
      receiver: cred1.intentAddress,
    }),
    nullifier: nullifierC,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const intentShares = await balanceOf(publicClient, mocks.usdcVault, cred1.intentAddress);
  const intentBal3 = await balanceOf(publicClient, health.evmTokenAddress, cred1.intentAddress);
  if (intentShares !== depositAmount) throw new Error("vault shares mismatch");
  if (intentBal3 !== intentBal2 - depositAmount) throw new Error("intent bUSDC after deposit wrong");
  log(`✓ intent vault-shares: ${formatUnits(intentShares, 6)}; intent bUSDC: ${formatUnits(intentBal3, 6)}`);

  // ---- D: vault withdraw -------------------------------------------------
  section("D. Vault withdraw — redeem all shares back to intent");
  const nullifierD = ("0x" + "00".repeat(31) + "0d") as Hex;

  await runBatch({
    label: "vault-withdraw",
    backend,
    credential: cred1,
    calls: vaultWithdrawFlow({
      vault: mocks.usdcVault,
      shares: intentShares,
      receiver: cred1.intentAddress,
      owner: cred1.intentAddress,
    }),
    nullifier: nullifierD,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const intentSharesAfter = await balanceOf(publicClient, mocks.usdcVault, cred1.intentAddress);
  const intentBal4 = await balanceOf(publicClient, health.evmTokenAddress, cred1.intentAddress);
  if (intentSharesAfter !== 0n) throw new Error("shares should be zero after full redeem");
  if (intentBal4 !== intentBal3 + intentShares) throw new Error("intent bUSDC after withdraw wrong");
  log(`✓ intent vault-shares: 0; intent bUSDC: ${formatUnits(intentBal4, 6)}`);

  // ========================================================================
  // Scenario E: three-tx FULL PRIVACY roundtrip on a FRESH intent account.
  //   Aztec -> EVM -> swap -> lend -> unwind -> EVM -> Aztec (private again)
  //
  //   tx1: USDC -> WETH (kept in the intent)
  //   tx2: deposit WETH into the WETH vault
  //   tx3: redeem + swap back to USDC, deliver to reverse-bridge deposit addr
  //   (off-chain) reverse bridge detects the deposit and mints private USDC
  //               on Aztec to a chosen Aztec address.
  // ========================================================================
  section("E. Privacy roundtrip — Aztec -> EVM intent flow -> Aztec");

  if (!health.reverseBridgeDepositAddress) throw new Error("reverse bridge deposit address missing from /api/health");
  if (!health.minterAddress) throw new Error("minter address missing from /api/health");
  log(`Reverse bridge deposit address (EVM): ${health.reverseBridgeDepositAddress}`);
  log(`Final Aztec recipient (server minter): ${health.minterAddress}`);

  const cred2 = await generateCredential(publicClient, intentD.factory);
  log(`preimage: ${cred2.preimage.toString()}`);
  log(`salt:     ${cred2.salt.toString()}`);
  log(`intent:   ${cred2.intentAddress}`);

  const reverseBridgeWallet = health.reverseBridgeDepositAddress;
  const bridgeWalletUsdcBefore = await balanceOf(publicClient, health.evmTokenAddress, reverseBridgeWallet);

  section("E. Bridge 100 bUSDC to intent #2");
  await bridge.bridgeToEvm({
    evmAddress: cred2.intentAddress,
    amountMicro: bridgeAmount,
    onProgress: log,
  });
  const e0IntentUsdc = await balanceOf(publicClient, health.evmTokenAddress, cred2.intentAddress);
  log(`intent bUSDC after bridge: ${formatUnits(e0IntentUsdc, 6)}`);
  if (e0IntentUsdc !== bridgeAmount) throw new Error("bridge delta wrong for roundtrip");

  // tx1 ------------------------------------------------------------------
  section("E.tx1 — swap 100 bUSDC -> WETH, kept in intent");
  const nE1 = ("0x" + "00".repeat(31) + "e1") as Hex;
  const expectedWeth = (bridgeAmount * 10n ** 18n) / 10n ** 6n;
  await runBatch({
    label: "rt/tx1",
    backend,
    credential: cred2,
    calls: swapAndSendFlow({
      router: mocks.swapRouter,
      tokenIn: health.evmTokenAddress,
      tokenOut: mocks.weth,
      amountIn: bridgeAmount,
      minAmountOut: (expectedWeth * 99n) / 100n,
      recipient: cred2.intentAddress,
    }),
    nullifier: nE1,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });
  const e1IntentUsdc = await balanceOf(publicClient, health.evmTokenAddress, cred2.intentAddress);
  const e1IntentWeth = await balanceOf(publicClient, mocks.weth, cred2.intentAddress);
  if (e1IntentUsdc !== 0n) throw new Error("intent bUSDC should be 0 after full swap");
  if (e1IntentWeth !== expectedWeth) throw new Error(`intent WETH mismatch: ${e1IntentWeth} vs ${expectedWeth}`);
  log(`✓ intent bUSDC: 0; intent WETH: ${formatUnits(e1IntentWeth, 18)}`);

  // tx2 ------------------------------------------------------------------
  section("E.tx2 — deposit all WETH into WETH vault");
  const nE2 = ("0x" + "00".repeat(31) + "e2") as Hex;
  await runBatch({
    label: "rt/tx2",
    backend,
    credential: cred2,
    calls: vaultDepositFlow({
      vault: mocks.wethVault,
      asset: mocks.weth,
      amount: e1IntentWeth,
      receiver: cred2.intentAddress,
    }),
    nullifier: nE2,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });
  const e2IntentWeth = await balanceOf(publicClient, mocks.weth, cred2.intentAddress);
  const e2IntentShares = await balanceOf(publicClient, mocks.wethVault, cred2.intentAddress);
  if (e2IntentWeth !== 0n) throw new Error("intent WETH should be 0 after full deposit");
  if (e2IntentShares !== e1IntentWeth) throw new Error("WETH-vault shares mismatch");
  log(`✓ intent WETH: 0; WETH-vault shares: ${formatUnits(e2IntentShares, 18)}`);

  // tx3 ------------------------------------------------------------------
  //   Prepare the reverse-bridge session FIRST, then submit tx3 whose final
  //   swap sends exactly `bridgeAmount` bUSDC to the reverse-bridge deposit
  //   address. The bridge watches its wallet balance and matches the increase
  //   against the pending session by amount.
  //
  //   Call order inside tx3: redeem(shares) -> approve(router) -> swap(WETH->USDC to reverseBridgeWallet)
  //   One proof, three calls, atomic.
  section("E.tx3 — redeem + swap back to USDC, delivered to reverse bridge");
  const nE3 = ("0x" + "00".repeat(31) + "e3") as Hex;

  log(`Creating reverse-bridge session for ${formatUnits(bridgeAmount, 6)} bUSDC -> ${health.minterAddress}`);
  const reverseSession = await bridge.initiateReverse(health.minterAddress, bridgeAmount);
  log(`reverse bridge sessionId: ${reverseSession.sessionId}`);
  if (reverseSession.depositAddress.toLowerCase() !== reverseBridgeWallet.toLowerCase()) {
    throw new Error(`reverse bridge deposit address mismatch: ${reverseSession.depositAddress} vs ${reverseBridgeWallet}`);
  }

  const redeemCall = vaultWithdrawFlow({
    vault: mocks.wethVault,
    shares: e2IntentShares,
    receiver: cred2.intentAddress,
    owner: cred2.intentAddress,
  });
  const swapBackCalls = swapAndSendFlow({
    router: mocks.swapRouter,
    tokenIn: mocks.weth,
    tokenOut: health.evmTokenAddress,
    amountIn: e2IntentShares,
    minAmountOut: bridgeAmount, // must land EXACTLY bridgeAmount at the bridge wallet for session match
    recipient: reverseBridgeWallet,
  });
  const roundtripCalls: Call[] = [...redeemCall, ...swapBackCalls];

  await runBatch({
    label: "rt/tx3",
    backend,
    credential: cred2,
    calls: roundtripCalls,
    nullifier: nE3,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const eFinalIntentUsdc = await balanceOf(publicClient, health.evmTokenAddress, cred2.intentAddress);
  const eFinalIntentWeth = await balanceOf(publicClient, mocks.weth, cred2.intentAddress);
  const eFinalIntentShares = await balanceOf(publicClient, mocks.wethVault, cred2.intentAddress);
  const bridgeWalletUsdcAfter = await balanceOf(publicClient, health.evmTokenAddress, reverseBridgeWallet);
  const bridgeDelta = bridgeWalletUsdcAfter - bridgeWalletUsdcBefore;

  if (eFinalIntentUsdc !== 0n) throw new Error("intent bUSDC should be 0 after roundtrip");
  if (eFinalIntentWeth !== 0n) throw new Error("intent WETH should be 0 after roundtrip");
  if (eFinalIntentShares !== 0n) throw new Error("intent WETH-vault shares should be 0 after roundtrip");
  if (bridgeDelta !== bridgeAmount) throw new Error(`bridge wallet bUSDC delta: ${bridgeDelta}, expected ${bridgeAmount}`);
  log(`✓ intent account drained: bUSDC=0 WETH=0 shares=0`);
  log(`✓ reverse-bridge wallet received ${formatUnits(bridgeDelta, 6)} bUSDC (awaiting Aztec mint)`);

  section("E.tx3' — wait for reverse bridge to mint private USDC on Aztec");
  await bridge.waitForReverseBridge(reverseSession.sessionId, { onProgress: log });
  log(`✓ reverse bridge completed — ${formatUnits(bridgeAmount, 6)} private USDC minted on Aztec to ${health.minterAddress}`);

  section("ALL INTENT FLOW TESTS PASSED");
  log(`Scenarios A–D on credential #1: transfer, replay-revert, swap, vault deposit, vault withdraw`);
  log(`Scenario E on credential #2:     Aztec -> EVM intent -> swap -> lend -> swap back -> Aztec`);
  log(`  — three EVM batches on one intent account, three nullifiers, three proofs`);
  log(`  — 100 bUSDC made the full privacy round trip:`);
  log(`      private Aztec note -> public EVM swap/lend/unwind -> private Aztec note again`);

  await backend.bb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test-intent] FAILED:", err);
  process.exit(1);
});
