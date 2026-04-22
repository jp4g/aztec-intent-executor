/**
 * Intent Executor Integration Test
 *
 * Exercises the full non-custodial intent flow plus composed action flows
 * built on top of executeBatch:
 *
 *   A.  transfer         — one call
 *   A'. replay negative  — reuses consumed nullifier
 *   B.  swap-and-send    — approve + swap (two calls)
 *   C.  vault deposit    — approve + deposit into bUSDC vault (two calls)
 *   D.  vault withdraw   — redeem from bUSDC vault (one call)
 *   E.  roundtrip        — THREE separate batches on a fresh intent account:
 *       tx1: approve + swap (USDC -> WETH, kept in the intent account)
 *       tx2: approve + deposit into WETH vault
 *       tx3: redeem + approve + swap (WETH -> USDC, recipient = user EOA)
 *       — demonstrates that the account is reusable across sessions with
 *         multiple nullifiers, and that outputs can be routed anywhere.
 *
 * Prereqs (see README §Intent Executor):
 *   - anvil on :8545, aztec sandbox on :8080, bridge server on :3001
 *   - yarn evm:deploy          (bUSDC)
 *   - yarn evm:deploy:mocks    (MockWETH, MockSwapRouter, two MockLendingVault)
 *   - yarn evm:deploy:intent   (HonkVerifier, IntentAccount impl, factory)
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

interface Health {
  evmTokenAddress: Hex;
  bridgeEnabled: boolean;
}

function section(title: string) {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}

function log(msg: string, data?: unknown) {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  if (data !== undefined) console.log(`[${ts}] ${msg}`, data);
  else console.log(`[${ts}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getHealth(): Promise<Health> {
  const res = await fetch(`${SERVER_URL}/api/health`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error("Server not ready");
  if (!data.bridgeEnabled) throw new Error("Bridge not enabled on server");
  return { evmTokenAddress: data.evmTokenAddress, bridgeEnabled: data.bridgeEnabled };
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

async function bridgeBusdcToAddress(evmAddress: Hex, amountMicro: bigint): Promise<void> {
  log(`Initiating bridge session targeting ${evmAddress}...`);
  const initRes = await fetch(`${SERVER_URL}/api/bridge/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evmAddress }),
  });
  const initData = await initRes.json();
  if (!initData.success) throw new Error(`initiate failed: ${JSON.stringify(initData)}`);
  const depositAddr = initData.aztecDepositAddress as string;
  log(`Bridge deposit address: ${depositAddr}`);

  log(`Minting ${amountMicro} USDC privately to deposit address...`);
  const transferRes = await fetch(`${SERVER_URL}/api/test/transfer-private`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: depositAddr, amount: amountMicro.toString() }),
  });
  const transferData = await transferRes.json();
  if (!transferData.success) throw new Error(`transfer-private failed: ${JSON.stringify(transferData)}`);

  log("Waiting for bridge to detect deposit and mint bUSDC on EVM...");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${SERVER_URL}/api/bridge/status/${depositAddr}`);
    const statusData = await statusRes.json();
    if (statusData.status === "not_found") {
      log("Bridge session completed.");
      return;
    }
    await sleep(3000);
  }
  throw new Error("Bridge did not complete within timeout");
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

  const health = await getHealth();
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
  await bridgeBusdcToAddress(cred1.intentAddress, bridgeAmount);
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
  // Scenario E: three-tx roundtrip on a FRESH intent account.
  //   tx1: USDC -> WETH (kept in the intent)
  //   tx2: deposit WETH into the WETH vault
  //   tx3: redeem shares, swap back to USDC, deliver to user EOA
  // ========================================================================
  section("E. Roundtrip — new intent account for a USDC→WETH→vault→USDC→EOA flow");

  const userEoa = EXTERNAL_RECIPIENT;
  log(`User EOA (final destination): ${userEoa}`);
  const cred2 = await generateCredential(publicClient, intentD.factory);
  log(`preimage: ${cred2.preimage.toString()}`);
  log(`salt:     ${cred2.salt.toString()}`);
  log(`intent:   ${cred2.intentAddress}`);

  const eoaUsdcBefore = await balanceOf(publicClient, health.evmTokenAddress, userEoa);

  section("E. Bridge 100 bUSDC to intent #2");
  await bridgeBusdcToAddress(cred2.intentAddress, bridgeAmount);
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
  //   Call order: redeem(shares) -> approve(router, weth) -> swap(WETH->USDC to EOA)
  //   One proof, three calls, atomic.
  section("E.tx3 — redeem + swap back to USDC, delivered to user EOA");
  const nE3 = ("0x" + "00".repeat(31) + "e3") as Hex;

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
    amountIn: e2IntentShares, // full redeemed amount
    minAmountOut: (bridgeAmount * 99n) / 100n,
    recipient: userEoa,
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
  const eFinalEoaUsdc = await balanceOf(publicClient, health.evmTokenAddress, userEoa);
  const eoaDelta = eFinalEoaUsdc - eoaUsdcBefore;

  if (eFinalIntentUsdc !== 0n) throw new Error("intent bUSDC should be 0 after roundtrip");
  if (eFinalIntentWeth !== 0n) throw new Error("intent WETH should be 0 after roundtrip");
  if (eFinalIntentShares !== 0n) throw new Error("intent WETH-vault shares should be 0 after roundtrip");
  if (eoaDelta !== bridgeAmount) throw new Error(`EOA USDC delta: ${eoaDelta}, expected ${bridgeAmount}`);
  log(`✓ intent account drained: bUSDC=0 WETH=0 shares=0`);
  log(`✓ user EOA received ${formatUnits(eoaDelta, 6)} bUSDC (delta from roundtrip)`);

  section("ALL INTENT FLOW TESTS PASSED");
  log(`Scenarios A–D on credential #1: transfer, replay-revert, swap, vault deposit, vault withdraw`);
  log(`Scenario E on credential #2:     USDC -> WETH -> WETH-vault -> WETH -> USDC -> EOA`);
  log(`  — three separate batches on the same intent account, three nullifiers, three proofs`);
  log(`  — 100 bUSDC made the full round trip and was delivered to ${userEoa}`);

  await backend.bb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test-intent] FAILED:", err);
  process.exit(1);
});
