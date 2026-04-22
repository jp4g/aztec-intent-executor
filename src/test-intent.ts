/**
 * Intent Executor Integration Test
 *
 * Exercises the full non-custodial intent flow plus three composed action
 * flows built on top of executeBatch:
 *   A. transfer         — one call
 *   B. swap-and-send    — approve + swap (two calls)
 *   C. vault deposit    — approve + deposit (two calls)
 *   D. vault withdraw   — redeem (one call)
 *
 * Plus negative cases:
 *   - replay of a consumed nullifier reverts
 *
 * Prereqs (see README §Intent Executor):
 *   - anvil on :8545, aztec sandbox on :8080, bridge server on :3001
 *   - yarn evm:deploy          (bUSDC)
 *   - yarn evm:deploy:mocks    (MockTokenB, MockSwapRouter, MockLendingVault)
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
  FACTORY_ABI,
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
// Account #1 is used as the external EVM recipient in the swap flow.
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
  tokenB: Hex;
  swapRouter: Hex;
  vault: Hex;
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

/**
 * Run one batch end-to-end: build proof → submit → wait for receipt.
 * Used by every scenario.
 */
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
  log(`[${params.label}] proof: ${proof.proof.length} bytes`);

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
  log(`bUSDC:            ${health.evmTokenAddress}`);
  log(`IntentFactory:    ${intentD.factory}`);
  log(`MockTokenB:       ${mocks.tokenB}`);
  log(`MockSwapRouter:   ${mocks.swapRouter}`);
  log(`MockLendingVault: ${mocks.vault}`);

  const publicClient = localPublicClient(EVM_RPC_URL);
  const walletClient = createWalletClient({
    account: privateKeyToAccount(BRIDGE_PRIVATE_KEY),
    chain: foundry,
    transport: http(EVM_RPC_URL),
  });

  section("Initialize UltraHonk backend");
  const backend = await createBackend();
  log("Barretenberg + UltraHonkBackend ready");

  // One credential used for the whole session. The account is reused across
  // all four scenarios; each scenario consumes its own nullifier.
  section("Generate credential (preimage -> salt -> intent address)");
  const credential = await generateCredential(publicClient, intentD.factory);
  log(`preimage: ${credential.preimage.toString()}`);
  log(`salt:     ${credential.salt.toString()}`);
  log(`intent:   ${credential.intentAddress}`);

  section("Bridge bUSDC from Aztec to the intent address");
  const bridgeAmount = parseUnits(BRIDGE_AMOUNT_USDC.toString(), 6);
  await bridgeBusdcToAddress(credential.intentAddress, bridgeAmount);
  const intentBal0 = await balanceOf(publicClient, health.evmTokenAddress, credential.intentAddress);
  log(`intent bUSDC after bridge: ${formatUnits(intentBal0, 6)}`);
  if (intentBal0 !== bridgeAmount) throw new Error(`bridge produced ${intentBal0}, expected ${bridgeAmount}`);

  // ---- Scenario A: simple transfer -----------------------------------------
  section("A. Transfer flow — 40 bUSDC to external recipient");
  const nullifierA = ("0x" + "00".repeat(31) + "0a") as Hex;
  const amountA = parseUnits("40", 6);
  const extRecipBefore = await balanceOf(publicClient, health.evmTokenAddress, EXTERNAL_RECIPIENT);

  await runBatch({
    label: "transfer",
    backend,
    credential,
    calls: transferFlow(health.evmTokenAddress, EXTERNAL_RECIPIENT, amountA),
    nullifier: nullifierA,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const extRecipAfterA = await balanceOf(publicClient, health.evmTokenAddress, EXTERNAL_RECIPIENT);
  const intentBal1 = await balanceOf(publicClient, health.evmTokenAddress, credential.intentAddress);
  if (extRecipAfterA - extRecipBefore !== amountA) throw new Error("transfer recipient delta wrong");
  if (intentBal1 !== intentBal0 - amountA) throw new Error("intent balance after transfer wrong");
  log(`✓ external recipient +${formatUnits(amountA, 6)} bUSDC; intent ${formatUnits(intentBal1, 6)}`);

  // Sanity: on-chain clone was deployed with the correct salt.
  const onchainSalt = (await publicClient.readContract({
    address: credential.intentAddress,
    abi: ACCOUNT_ABI,
    functionName: "salt",
  })) as Hex;
  if (onchainSalt.toLowerCase() !== credential.salt.toString().toLowerCase()) {
    throw new Error(`on-chain salt mismatch: ${onchainSalt} vs ${credential.salt.toString()}`);
  }

  // ---- Scenario negative: replay of Scenario A must revert -----------------
  section("A'. Replay transfer batch — expect Replay revert");
  const replayCalls = transferFlow(health.evmTokenAddress, EXTERNAL_RECIPIENT, amountA);
  const { proof: replayProof } = await proveBatch({
    backend,
    credential,
    calls: replayCalls,
    nullifier: nullifierA, // reused on purpose
    chainId: FOUNDRY_CHAIN_ID,
  });
  try {
    await publicClient.simulateContract({
      account: walletClient.account!,
      address: credential.intentAddress,
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

  // ---- Scenario B: swap-and-send ------------------------------------------
  section("B. Swap-and-send — 30 bUSDC -> mTKN to external recipient");
  const nullifierB = ("0x" + "00".repeat(31) + "0b") as Hex;
  const amountInB = parseUnits("30", 6);
  const minOutB = parseUnits("29", 18); // allow a small buffer vs the 1:1 rate
  const mtknBefore = await balanceOf(publicClient, mocks.tokenB, EXTERNAL_RECIPIENT);

  await runBatch({
    label: "swap",
    backend,
    credential,
    calls: swapAndSendFlow({
      router: mocks.swapRouter,
      tokenIn: health.evmTokenAddress,
      tokenOut: mocks.tokenB,
      amountIn: amountInB,
      minAmountOut: minOutB,
      recipient: EXTERNAL_RECIPIENT,
    }),
    nullifier: nullifierB,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const mtknAfter = await balanceOf(publicClient, mocks.tokenB, EXTERNAL_RECIPIENT);
  const intentBal2 = await balanceOf(publicClient, health.evmTokenAddress, credential.intentAddress);
  const expectedOut = (amountInB * 10n ** 18n) / 10n ** 6n; // router rate is 1e18/1e6
  if (mtknAfter - mtknBefore !== expectedOut) {
    throw new Error(`swap output mismatch: got ${mtknAfter - mtknBefore}, expected ${expectedOut}`);
  }
  if (intentBal2 !== intentBal1 - amountInB) throw new Error("intent bUSDC after swap wrong");
  log(`✓ external recipient +${formatUnits(expectedOut, 18)} mTKN; intent ${formatUnits(intentBal2, 6)} bUSDC`);

  // ---- Scenario C: vault deposit ------------------------------------------
  section("C. Vault deposit — 20 bUSDC into MockLendingVault");
  const nullifierC = ("0x" + "00".repeat(31) + "0c") as Hex;
  const depositAmount = parseUnits("20", 6);

  await runBatch({
    label: "vault-deposit",
    backend,
    credential,
    calls: vaultDepositFlow({
      vault: mocks.vault,
      asset: health.evmTokenAddress,
      amount: depositAmount,
      receiver: credential.intentAddress,
    }),
    nullifier: nullifierC,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const intentShares = await balanceOf(publicClient, mocks.vault, credential.intentAddress);
  const intentBal3 = await balanceOf(publicClient, health.evmTokenAddress, credential.intentAddress);
  if (intentShares !== depositAmount) throw new Error("vault shares mismatch");
  if (intentBal3 !== intentBal2 - depositAmount) throw new Error("intent bUSDC after deposit wrong");
  log(`✓ intent vault-shares: ${formatUnits(intentShares, 6)}; intent bUSDC: ${formatUnits(intentBal3, 6)}`);

  // ---- Scenario D: vault withdraw -----------------------------------------
  section("D. Vault withdraw — redeem all shares back to intent");
  const nullifierD = ("0x" + "00".repeat(31) + "0d") as Hex;

  await runBatch({
    label: "vault-withdraw",
    backend,
    credential,
    calls: vaultWithdrawFlow({
      vault: mocks.vault,
      shares: intentShares,
      receiver: credential.intentAddress,
      owner: credential.intentAddress,
    }),
    nullifier: nullifierD,
    walletClient,
    publicClient,
    factory: intentD.factory,
  });

  const intentSharesAfter = await balanceOf(publicClient, mocks.vault, credential.intentAddress);
  const intentBal4 = await balanceOf(publicClient, health.evmTokenAddress, credential.intentAddress);
  if (intentSharesAfter !== 0n) throw new Error("shares should be zero after full redeem");
  if (intentBal4 !== intentBal3 + intentShares) throw new Error("intent bUSDC after withdraw wrong");
  log(`✓ intent vault-shares: 0; intent bUSDC: ${formatUnits(intentBal4, 6)}`);

  section("ALL INTENT FLOW TESTS PASSED");
  log(`- bridged ${formatUnits(bridgeAmount, 6)} bUSDC to ${credential.intentAddress}`);
  log(`- ran transfer, swap-and-send, vault deposit, vault withdraw — each in one proof`);
  log(`- replay of a consumed nullifier reverted as expected`);
  log(`- final intent bUSDC: ${formatUnits(intentBal4, 6)}`);
  log(`- external recipient final: ${formatUnits(extRecipAfterA, 6)} bUSDC + ${formatUnits(mtknAfter, 18)} mTKN`);

  await backend.bb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test-intent] FAILED:", err);
  process.exit(1);
});
