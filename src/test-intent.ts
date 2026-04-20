/**
 * Intent Executor Integration Test
 *
 * Exercises the full non-custodial intent flow:
 *  1. Generate a random preimage; derive salt = Poseidon2(preimage).
 *  2. Compute the predicted IntentAccount clone address via factory.predict.
 *  3. Bridge bUSDC from Aztec to that predicted address (reuses existing bridge).
 *  4. Build a transfer action, generate a Noir proof, submit deployAndExecute.
 *  5. Assert the transfer happened and the nullifier is marked.
 *  6. Test replay revert and a distinct second action with a different nullifier.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend, type ProofData } from "@aztec/bb.js";
import "dotenv/config";

const SERVER_URL = "http://localhost:3001";
const EVM_RPC_URL = "http://localhost:8545";
const BRIDGE_AMOUNT_USDC = 100n;

// Anvil default account #0 is the bridge operator.
// Account #1 is used as the demo recipient for the executed intent transfer.
const BRIDGE_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const FACTORY_ABI = parseAbi([
  "function predict(bytes32 salt) view returns (address)",
  "function deploy(bytes32 salt) returns (address)",
  "function deployAndExecute(bytes32 salt,address target,uint256 value,bytes data,bytes32 nullifier,bytes proof) returns (bytes)",
]);

const ACCOUNT_ABI = parseAbi([
  "function execute(address target,uint256 value,bytes data,bytes32 nullifier,bytes proof) returns (bytes)",
  "function nullified(bytes32) view returns (bool)",
  "function salt() view returns (bytes32)",
]);

interface IntentDeployment {
  verifier: Hex;
  implementation: Hex;
  factory: Hex;
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
  const path = resolve(process.cwd(), "intent-deployment.json");
  return JSON.parse(readFileSync(path, "utf8")) as IntentDeployment;
}

// Split a 32-byte hash into two 16-byte halves, each represented as a bytes32
// with the 16 bytes in the low-order positions. Matches the Noir circuit's
// expected encoding for action_hash_hi / action_hash_lo.
function splitHash(hash: Hex): { hi: Hex; lo: Hex } {
  const raw = hash.slice(2);
  const hi = `0x${"0".repeat(32)}${raw.slice(0, 32)}` as Hex;
  const lo = `0x${"0".repeat(32)}${raw.slice(32, 64)}` as Hex;
  return { hi, lo };
}

// Match IntentAccount._computeActionHash layout: abi.encode(chainid, address(this), target, value, data, nullifier)
async function computeActionHash(
  chainId: bigint,
  account: Hex,
  target: Hex,
  value: bigint,
  data: Hex,
  nullifier: Hex,
): Promise<Hex> {
  const { encodeAbiParameters, sha256 } = await import("viem");
  const encoded = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bytes32" },
    ],
    [chainId, account, target, value, data, nullifier],
  );
  return sha256(encoded);
}

async function bridgeBusdcToAddress(
  evmAddress: Hex,
  amountMicro: bigint,
): Promise<void> {
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

async function proveIntent(params: {
  circuit: any;
  backend: UltraHonkBackend;
  preimage: Fr;
  salt: Fr;
  actionHashHi: Hex;
  actionHashLo: Hex;
}): Promise<ProofData> {
  const noir = new Noir(params.circuit);
  const { witness } = await noir.execute({
    preimage: params.preimage.toString(),
    salt: params.salt.toString(),
    action_hash_hi: params.actionHashHi,
    action_hash_lo: params.actionHashLo,
  });
  return params.backend.generateProof(witness, { verifierTarget: "evm" });
}

async function main() {
  section("INTENT EXECUTOR INTEGRATION TEST");

  const health = await getHealth();
  log(`EVM bUSDC address: ${health.evmTokenAddress}`);
  const deployment = readIntentDeployment();
  log(`IntentAccountFactory: ${deployment.factory}`);
  log(`IntentAccount (impl): ${deployment.implementation}`);
  log(`IntentVerifier:       ${deployment.verifier}`);

  const publicClient = createPublicClient({ chain: foundry, transport: http(EVM_RPC_URL) });
  const bridgeAccount = privateKeyToAccount(BRIDGE_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account: bridgeAccount,
    chain: foundry,
    transport: http(EVM_RPC_URL),
  });

  // ---- 1. Credential ------------------------------------------------------
  section("1. Generate credential (preimage -> salt -> intent address)");
  const preimage = Fr.random();
  const salt = await poseidon2Hash([preimage]);
  log(`preimage: ${preimage.toString()}`);
  log(`salt:     ${salt.toString()}`);

  const intentAddress = (await publicClient.readContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: "predict",
    args: [salt.toString() as Hex],
  })) as Hex;
  log(`predicted IntentAccount: ${intentAddress}`);

  // ---- 2. Bridge to intent address ---------------------------------------
  section("2. Bridge bUSDC from Aztec to the intent address");
  const amountMicro = parseUnits(BRIDGE_AMOUNT_USDC.toString(), 6);
  const balanceBefore = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [intentAddress],
  })) as bigint;
  log(`intent address balance before: ${formatUnits(balanceBefore, 6)} bUSDC`);

  await bridgeBusdcToAddress(intentAddress, amountMicro);

  const balanceAfterBridge = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [intentAddress],
  })) as bigint;
  log(`intent address balance after bridge: ${formatUnits(balanceAfterBridge, 6)} bUSDC`);
  if (balanceAfterBridge - balanceBefore !== amountMicro) {
    throw new Error(`Bridge did not mint expected amount (got ${balanceAfterBridge - balanceBefore})`);
  }

  // ---- 3. Noir backend setup ---------------------------------------------
  section("3. Load circuit + init Barretenberg");
  const circuitPath = resolve(process.cwd(), "circuits/intent/target/intent.json");
  const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));
  const bb = await Barretenberg.new({ threads: 1 });
  const backend = new UltraHonkBackend(circuit.bytecode, bb);
  log("Barretenberg + UltraHonkBackend ready");

  const chainId = BigInt(foundry.id);

  // ---- 4. First action: transfer 40 bUSDC to the demo recipient ---------
  section("4. Execute intent action #1 (transfer 40 bUSDC)");
  const nullifier1 = ("0x" + "00".repeat(31) + "01") as Hex;
  const transferAmount1 = parseUnits("40", 6);
  const transferCalldata1 = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [RECIPIENT_ADDRESS, transferAmount1],
  });
  const actionHash1 = await computeActionHash(
    chainId,
    intentAddress,
    health.evmTokenAddress,
    0n,
    transferCalldata1,
    nullifier1,
  );
  const { hi: hi1, lo: lo1 } = splitHash(actionHash1);
  log(`action hash: ${actionHash1}`);

  log("Generating Noir proof...");
  const proof1 = await proveIntent({
    circuit,
    backend,
    preimage,
    salt,
    actionHashHi: hi1,
    actionHashLo: lo1,
  });
  log(`proof length: ${proof1.proof.length} bytes; public inputs: ${proof1.publicInputs.length}`);

  const recipBalBefore = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [RECIPIENT_ADDRESS],
  })) as bigint;

  log("Submitting deployAndExecute...");
  const hash1 = await walletClient.writeContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: "deployAndExecute",
    args: [
      salt.toString() as Hex,
      health.evmTokenAddress,
      0n,
      transferCalldata1,
      nullifier1,
      `0x${Buffer.from(proof1.proof).toString("hex")}` as Hex,
    ],
  });
  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 });
  log(`tx mined at block ${receipt1.blockNumber}, status: ${receipt1.status}`);
  if (receipt1.status !== "success") throw new Error("deployAndExecute reverted");

  const recipBalAfter = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [RECIPIENT_ADDRESS],
  })) as bigint;
  const intentBalAfter = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [intentAddress],
  })) as bigint;
  log(`recipient delta: +${formatUnits(recipBalAfter - recipBalBefore, 6)} bUSDC`);
  log(`intent balance:  ${formatUnits(intentBalAfter, 6)} bUSDC (started ${formatUnits(amountMicro, 6)})`);
  if (recipBalAfter - recipBalBefore !== transferAmount1) throw new Error("recipient did not receive transfer");
  if (intentBalAfter !== amountMicro - transferAmount1) throw new Error("intent balance wrong");

  // Clone should now be deployed with correct salt + nullifier marked
  const onchainSalt = (await publicClient.readContract({
    address: intentAddress,
    abi: ACCOUNT_ABI,
    functionName: "salt",
  })) as Hex;
  if (onchainSalt.toLowerCase() !== (salt.toString() as string).toLowerCase()) {
    throw new Error(`on-chain salt mismatch: ${onchainSalt} vs ${salt.toString()}`);
  }
  const n1Used = (await publicClient.readContract({
    address: intentAddress,
    abi: ACCOUNT_ABI,
    functionName: "nullified",
    args: [nullifier1],
  })) as boolean;
  if (!n1Used) throw new Error("nullifier1 not marked used");
  log("nullifier1 marked used ✓");

  // ---- 5. Replay same proof+nullifier should revert ---------------------
  section("5. Replay action #1 -> expect revert");
  try {
    await publicClient.simulateContract({
      account: bridgeAccount,
      address: intentAddress,
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [
        health.evmTokenAddress,
        0n,
        transferCalldata1,
        nullifier1,
        `0x${Buffer.from(proof1.proof).toString("hex")}` as Hex,
      ],
    });
    throw new Error("expected replay to revert");
  } catch (err: any) {
    if (err.message === "expected replay to revert") throw err;
    log(`replay reverted as expected: ${err.shortMessage ?? err.message}`);
  }

  // ---- 6. Second action under same salt with new nullifier --------------
  section("6. Execute intent action #2 (different nullifier, same salt)");
  const nullifier2 = ("0x" + "00".repeat(31) + "02") as Hex;
  const transferAmount2 = parseUnits("15", 6);
  const transferCalldata2 = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [RECIPIENT_ADDRESS, transferAmount2],
  });
  const actionHash2 = await computeActionHash(
    chainId,
    intentAddress,
    health.evmTokenAddress,
    0n,
    transferCalldata2,
    nullifier2,
  );
  const { hi: hi2, lo: lo2 } = splitHash(actionHash2);
  const proof2 = await proveIntent({
    circuit,
    backend,
    preimage,
    salt,
    actionHashHi: hi2,
    actionHashLo: lo2,
  });

  const hash2 = await walletClient.writeContract({
    address: intentAddress,
    abi: ACCOUNT_ABI,
    functionName: "execute",
    args: [
      health.evmTokenAddress,
      0n,
      transferCalldata2,
      nullifier2,
      `0x${Buffer.from(proof2.proof).toString("hex")}` as Hex,
    ],
  });
  const receipt2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
  if (receipt2.status !== "success") throw new Error("second execute reverted");
  const recipBalFinal = (await publicClient.readContract({
    address: health.evmTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [RECIPIENT_ADDRESS],
  })) as bigint;
  log(`recipient balance after action #2: ${formatUnits(recipBalFinal, 6)} bUSDC`);
  if (recipBalFinal - recipBalAfter !== transferAmount2) {
    throw new Error("second action did not transfer correctly");
  }

  section("ALL INTENT TESTS PASSED");
  log(`- bridged ${formatUnits(amountMicro, 6)} bUSDC to ${intentAddress}`);
  log(`- executed 2 actions proving knowledge of preimage for salt ${salt.toString()}`);
  log(`- recipient received ${formatUnits(recipBalFinal - recipBalBefore, 6)} bUSDC total`);
  await bb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test-intent] FAILED:", err);
  process.exit(1);
});
