/**
 * Intent Executor Security Tests
 *
 * Standalone from the bridge — just needs Anvil + deployed intent contracts
 * + deployed mocks. The bUSDC owner (Anvil account #0) mints bUSDC directly
 * to intent accounts as needed, so we don't need the Aztec bridge.
 *
 * Cases covered (in order):
 *   1. Empty batch reverts (EmptyBatch)
 *   2. Tampered target in calls[] → InvalidProof
 *   3. Tampered value in calls[] → InvalidProof
 *   4. Tampered data in calls[] → InvalidProof
 *   5. Tampered nullifier → InvalidProof
 *   6. Reordered calls[] → InvalidProof
 *   7. Cross-account replay — proof for salt_A used against salt_B → InvalidProof
 *   8. Re-init attack — direct initialize() on already-deployed clone → reverts
 *   9. Duplicate deploy — factory.deploy(salt) twice → second reverts
 *  10. Call-level atomicity — batch with a failing call → whole batch reverts,
 *      prior call's state is rolled back
 *
 * Prereqs:
 *   yarn anvil
 *   yarn evm:deploy
 *   yarn evm:deploy:mocks
 *   yarn evm:deploy:intent
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  ACCOUNT_ABI,
  FACTORY_ABI,
  FOUNDRY_CHAIN_ID,
  PROOF_REJECTION_ERRORS,
  createBackend,
  generateCredential,
  localPublicClient,
  proveBatch,
  transferFlow,
  type BatchBackend,
  type Call,
  type Credential,
} from "./intent-client.js";

const EVM_RPC_URL = "http://localhost:8545";
const BRIDGE_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXTERNAL_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;

const BUSDC_MINT_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
]);

interface IntentDeployment {
  verifier: Hex;
  implementation: Hex;
  factory: Hex;
}
interface EvmDeployment { address: Hex }
interface MocksDeployment { weth: Hex; swapRouter: Hex; usdcVault: Hex; wethVault: Hex }

function section(title: string) {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}
function log(msg: string) {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${ts}] ${msg}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
}

function proofHex(proof: Uint8Array): Hex {
  return ("0x" + Buffer.from(proof).toString("hex")) as Hex;
}

function flipLowNibble(hex: Hex): Hex {
  // flip the last nibble of a 0x-prefixed hex string
  const last = hex.slice(-1);
  const flipped = (parseInt(last, 16) ^ 0x1).toString(16);
  return (hex.slice(0, -1) + flipped) as Hex;
}

/**
 * Run a tx that we expect to revert. Uses simulateContract so we don't burn
 * gas on-chain. Checks that the revert message contains `expectedNeedle`.
 */
/** Accept any verifier-family rejection as evidence of proof rejection. */
async function expectProofRejection(params: {
  label: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}): Promise<void> {
  try {
    await params.publicClient.simulateContract({
      account: params.walletClient.account!,
      address: params.address,
      abi: params.abi as any,
      functionName: params.functionName as any,
      args: params.args as any,
    });
    throw new Error(`[${params.label}] expected proof rejection, got success`);
  } catch (err: any) {
    if (err?.message?.includes("expected proof rejection, got success")) throw err;
    const errorName: string | undefined = err?.cause?.data?.errorName ?? err?.data?.errorName;
    const selector: string | undefined = err?.cause?.signature ?? err?.cause?.data?.args?.[0];
    const fullMsg = [err.shortMessage, err.details, err.message, errorName].filter(Boolean).join(" | ");
    if (errorName && PROOF_REJECTION_ERRORS.has(errorName)) {
      log(`✓ [${params.label}] rejected (${errorName})`);
      return;
    }
    // Fallback: the verifier selector we've observed but haven't decoded yet.
    // Use a looser match on "Failed", "InvalidProof", or a bare 0x... selector
    // with no ABI match (meaning *something* in the verifier reverted).
    if (/InvalidProof|SumcheckFailed|ShpleminiFailed|ConsistencyCheckFailed|PointAtInfinity|PublicInputsLengthWrong|ProofLengthWrong/i.test(fullMsg)) {
      log(`✓ [${params.label}] rejected (matched in message: ${fullMsg.slice(0, 160)}...)`);
      return;
    }
    throw new Error(`[${params.label}] expected proof rejection, got: ${fullMsg}`);
  }
}

async function expectRevert(params: {
  label: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  expectedNeedle: string;
}): Promise<void> {
  try {
    await params.publicClient.simulateContract({
      account: params.walletClient.account!,
      address: params.address,
      abi: params.abi as any,
      functionName: params.functionName as any,
      args: params.args as any,
    });
    throw new Error(`[${params.label}] expected revert, got success`);
  } catch (err: any) {
    if (err?.message?.startsWith("[") && err.message.includes("expected revert, got success")) throw err;
    // Dig out the decoded error name if viem unpacked it; fall back to text match on the full message.
    const errorName: string | undefined = err?.cause?.data?.errorName ?? err?.data?.errorName;
    const msg = [
      err.shortMessage,
      err.details,
      err.message,
      errorName,
      err?.cause?.message,
      err?.metaMessages?.join(" "),
    ].filter(Boolean).join(" | ");
    if (!msg.includes(params.expectedNeedle)) {
      throw new Error(`[${params.label}] expected revert matching "${params.expectedNeedle}", got: ${msg}`);
    }
    log(`✓ [${params.label}] reverted as expected (${params.expectedNeedle})`);
  }
}

async function readBalance(pc: PublicClient, token: Hex, owner: Hex): Promise<bigint> {
  return (await pc.readContract({
    address: token,
    abi: BUSDC_MINT_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

async function fundIntent(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  busdc: Hex;
  recipient: Hex;
  amount: bigint;
}): Promise<void> {
  const hash = await params.walletClient.writeContract({
    account: params.walletClient.account!,
    chain: params.walletClient.chain,
    address: params.busdc,
    abi: BUSDC_MINT_ABI,
    functionName: "mint",
    args: [params.recipient, params.amount],
  });
  await params.publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Deploy an intent clone at `cred.intentAddress` via a no-op self-transfer
 * (transferFlow with amount=0). This marks the clone as deployed and
 * initialized so we can then call executeBatch directly on it for the
 * security tests.
 */
async function bootstrapIntent(params: {
  backend: BatchBackend;
  credential: Credential;
  walletClient: WalletClient;
  publicClient: PublicClient;
  busdc: Hex;
  factory: Hex;
}): Promise<void> {
  const calls = transferFlow(params.busdc, EXTERNAL_RECIPIENT, 0n);
  const nullifier = ("0x" + "00".repeat(31) + "ff") as Hex;
  const { proof } = await proveBatch({
    backend: params.backend,
    credential: params.credential,
    calls,
    nullifier,
    chainId: FOUNDRY_CHAIN_ID,
  });
  const hash = await params.walletClient.writeContract({
    account: params.walletClient.account!,
    chain: params.walletClient.chain,
    address: params.factory,
    abi: FACTORY_ABI,
    functionName: "deployAndExecuteBatch",
    args: [
      params.credential.salt.toString() as Hex,
      calls,
      nullifier,
      proofHex(proof.proof),
    ],
  });
  await params.publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  section("INTENT EXECUTOR SECURITY TESTS");

  const evmD = readJson<EvmDeployment>("evm-deployment.json");
  const intentD = readJson<IntentDeployment>("intent-deployment.json");
  const mocks = readJson<MocksDeployment>("mocks-deployment.json");
  log(`bUSDC:         ${evmD.address}`);
  log(`Factory:       ${intentD.factory}`);
  log(`Impl:          ${intentD.implementation}`);
  log(`Verifier:      ${intentD.verifier}`);

  const publicClient = localPublicClient(EVM_RPC_URL);
  const walletClient = createWalletClient({
    account: privateKeyToAccount(BRIDGE_PRIVATE_KEY),
    chain: foundry,
    transport: http(EVM_RPC_URL),
  });

  section("Initialize UltraHonk backend");
  const backend = await createBackend();

  // Two credentials we'll need across multiple tests.
  section("Generate credentials A and B");
  const credA = await generateCredential(publicClient, intentD.factory);
  const credB = await generateCredential(publicClient, intentD.factory);
  log(`intentA: ${credA.intentAddress}`);
  log(`intentB: ${credB.intentAddress}`);

  // Fund both intent accounts directly (no bridge needed for these tests).
  const FUND = parseUnits("10", 6);
  await fundIntent({ walletClient, publicClient, busdc: evmD.address, recipient: credA.intentAddress, amount: FUND });
  await fundIntent({ walletClient, publicClient, busdc: evmD.address, recipient: credB.intentAddress, amount: FUND });
  log(`funded intentA and intentB with 10 bUSDC each via direct mint`);

  // Bootstrap both so the clones are on-chain; simplifies subsequent tests
  // that exercise the intent account directly rather than via the factory.
  section("Bootstrap clones A and B");
  await bootstrapIntent({ backend, credential: credA, walletClient, publicClient, busdc: evmD.address, factory: intentD.factory });
  await bootstrapIntent({ backend, credential: credB, walletClient, publicClient, busdc: evmD.address, factory: intentD.factory });
  log(`both clones deployed and initialized`);

  // ====================================================================
  // 1. Empty batch
  // ====================================================================
  section("1. Empty batch → EmptyBatch revert");
  {
    // An empty batch bails BEFORE the proof check, so any proof works.
    const dummyProof = ("0x" + "00".repeat(64)) as Hex;
    const nullifier = ("0x" + "00".repeat(31) + "01") as Hex;
    await expectRevert({
      label: "empty-batch",
      publicClient,
      walletClient,
      address: credA.intentAddress,
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [[], nullifier, dummyProof],
      expectedNeedle: "EmptyBatch",
    });
  }

  // ====================================================================
  // 2–5. Tampered action inputs — same proof, different submission bytes
  // ====================================================================
  section("2–5. Tampered action inputs → InvalidProof");

  // Canonical batch: transfer 1 bUSDC to EXTERNAL_RECIPIENT
  const canonCalls: Call[] = transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("1", 6));
  const canonNullifier = ("0x" + "00".repeat(31) + "10") as Hex;
  const { proof: canonProof } = await proveBatch({
    backend,
    credential: credA,
    calls: canonCalls,
    nullifier: canonNullifier,
    chainId: FOUNDRY_CHAIN_ID,
  });
  log(`canonical proof ready (${canonProof.proof.length} bytes)`);

  // 2. Tampered target
  const mutTarget: Call[] = [{ ...canonCalls[0], target: mocks.swapRouter }];
  await expectProofRejection({
    label: "tampered-target",
    publicClient, walletClient,
    address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
    args: [mutTarget, canonNullifier, proofHex(canonProof.proof)],
  });

  // 3. Tampered value
  const mutValue: Call[] = [{ ...canonCalls[0], value: 1n }];
  await expectProofRejection({
    label: "tampered-value",
    publicClient, walletClient,
    address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
    args: [mutValue, canonNullifier, proofHex(canonProof.proof)],
  });

  // 4. Tampered data (flip last nibble of the calldata)
  const mutData: Call[] = [{ ...canonCalls[0], data: flipLowNibble(canonCalls[0].data) }];
  await expectProofRejection({
    label: "tampered-data",
    publicClient, walletClient,
    address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
    args: [mutData, canonNullifier, proofHex(canonProof.proof)],
  });

  // 5. Tampered nullifier
  const mutNull = flipLowNibble(canonNullifier);
  await expectProofRejection({
    label: "tampered-nullifier",
    publicClient, walletClient,
    address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
    args: [canonCalls, mutNull, proofHex(canonProof.proof)],
  });

  // ====================================================================
  // 6. Reordered calls
  // ====================================================================
  section("6. Reordered calls → InvalidProof");
  {
    const call0 = transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("1", 6))[0];
    const call1 = transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("2", 6))[0];
    const orderedCalls: Call[] = [call0, call1];
    const nullifier = ("0x" + "00".repeat(31) + "11") as Hex;
    const { proof } = await proveBatch({
      backend, credential: credA, calls: orderedCalls, nullifier, chainId: FOUNDRY_CHAIN_ID,
    });

    const reorderedCalls: Call[] = [call1, call0];
    await expectProofRejection({
      label: "reordered-calls",
      publicClient, walletClient,
      address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
      args: [reorderedCalls, nullifier, proofHex(proof.proof)],
    });
  }

  // ====================================================================
  // 7. Cross-account replay — proof for cred A, submit on cred B
  // ====================================================================
  section("7. Cross-account replay (proof for A submitted on B) → InvalidProof");
  {
    const calls = transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("1", 6));
    const nullifier = ("0x" + "00".repeat(31) + "12") as Hex;
    // Prove using credA's intent address (computed inside proveBatch).
    const { proof } = await proveBatch({
      backend, credential: credA, calls, nullifier, chainId: FOUNDRY_CHAIN_ID,
    });
    // Submit against credB's intent account — the stored `salt` there is salt_B,
    // and action_hash is re-computed with address(this) = intentB. Both inputs
    // change vs what the proof committed to, so verifier.verify must fail.
    await expectProofRejection({
      label: "cross-account-replay",
      publicClient, walletClient,
      address: credB.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
      args: [calls, nullifier, proofHex(proof.proof)],
    });
  }

  // ====================================================================
  // 8. Re-init attack — direct initialize() on a deployed clone
  // ====================================================================
  section("8. Re-init attack — direct initialize() → InvalidInitialization");
  {
    const fakeSalt = ("0x" + "de".repeat(32)) as Hex;
    const fakeVerifier = "0x0000000000000000000000000000000000000001" as Hex;
    const INIT_ABI = parseAbi([
      "function initialize(bytes32 _salt, address _verifier) external",
      "error InvalidInitialization()",
    ]);
    await expectRevert({
      label: "re-init",
      publicClient, walletClient,
      address: credA.intentAddress, abi: INIT_ABI, functionName: "initialize",
      args: [fakeSalt, fakeVerifier],
      expectedNeedle: "InvalidInitialization",
    });
  }

  // ====================================================================
  // 9. Duplicate deploy — factory.deploy(salt) twice
  // ====================================================================
  section("9. Duplicate deploy — factory.deploy(salt) on already-deployed clone");
  {
    // credA's clone is already deployed. Calling factory.deploy(saltA) again
    // should revert — OZ Clones.cloneDeterministic uses create2 and fails if
    // the address has code.
    await expectRevert({
      label: "duplicate-deploy",
      publicClient, walletClient,
      address: intentD.factory, abi: FACTORY_ABI, functionName: "deploy",
      args: [credA.salt.toString() as Hex],
      // OZ 5.4+ Clones uses generic Errors.FailedDeployment
      expectedNeedle: "FailedDeployment",
    });
  }

  // ====================================================================
  // 10. Call-level atomicity — mid-batch revert rolls back the whole batch
  // ====================================================================
  section("10. Call-level atomicity — failing call reverts the whole batch");
  {
    // Batch: [transfer 1 bUSDC → EXTERNAL_RECIPIENT,
    //         transfer 1,000,000 bUSDC → EXTERNAL_RECIPIENT  (must fail — intent has only 10)]
    const calls = [
      transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("1", 6))[0],
      transferFlow(evmD.address, EXTERNAL_RECIPIENT, parseUnits("1000000", 6))[0],
    ];
    const nullifier = ("0x" + "00".repeat(31) + "13") as Hex;
    const { proof } = await proveBatch({
      backend, credential: credA, calls, nullifier, chainId: FOUNDRY_CHAIN_ID,
    });

    const recipBefore = await readBalance(publicClient, evmD.address, EXTERNAL_RECIPIENT);
    const intentBefore = await readBalance(publicClient, evmD.address, credA.intentAddress);

    await expectRevert({
      label: "atomicity",
      publicClient, walletClient,
      address: credA.intentAddress, abi: ACCOUNT_ABI, functionName: "executeBatch",
      args: [calls, nullifier, proofHex(proof.proof)],
      expectedNeedle: "CallFailed",
    });

    const recipAfter = await readBalance(publicClient, evmD.address, EXTERNAL_RECIPIENT);
    const intentAfter = await readBalance(publicClient, evmD.address, credA.intentAddress);
    if (recipAfter !== recipBefore) throw new Error("call 1's transfer should have been rolled back");
    if (intentAfter !== intentBefore) throw new Error("intent balance should be unchanged");
    log(`✓ call 1's state change rolled back (recip +0, intent ±0)`);
  }

  section("ALL SECURITY TESTS PASSED");
  log(`Checked: empty batch, 4 tampered-input variants, reordered calls,`);
  log(`         cross-account replay, re-init attack, duplicate deploy,`);
  log(`         call-level atomicity.`);

  await backend.bb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test-security] FAILED:", err);
  process.exit(1);
});
