/**
 * Intent Executor client SDK.
 *
 * Pure module — no server coupling. Consumed by src/test-intent.ts today and
 * anything else that wants to: generate a credential, predict a
 * counterfactual IntentAccount address, build typed batches for common
 * flows, prove a batch, and submit it.
 *
 * Circuit / verifier contract: unchanged across batches. The proof's public
 * inputs are [salt, action_hash_hi, action_hash_lo] regardless of batch size;
 * only the bytes fed into sha256(action_hash) differ.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  sha256,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { foundry } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend, type ProofData } from "@aztec/bb.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Call = {
  target: Hex;
  value: bigint;
  data: Hex;
};

export type Credential = {
  preimage: Fr;
  salt: Fr;
  intentAddress: Hex;
};

export type BatchBackend = {
  circuit: any;
  backend: UltraHonkBackend;
  bb: Barretenberg;
};

// ---------------------------------------------------------------------------
// ABI fragments (just what the client submits / predicts)
// ---------------------------------------------------------------------------

export const FACTORY_ABI = parseAbi([
  "function predict(bytes32 salt) view returns (address)",
  "function deploy(bytes32 salt) returns (address)",
  "function deployAndExecuteBatch(bytes32 salt, (address target,uint256 value,bytes data)[] calls, bytes32 nullifier, bytes proof) returns (bytes[])",
]);

export const ACCOUNT_ABI = parseAbi([
  "function executeBatch((address target,uint256 value,bytes data)[] calls, bytes32 nullifier, bytes proof) returns (bytes[])",
  "function nullified(bytes32) view returns (bool)",
  "function salt() view returns (bytes32)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

const SWAP_ROUTER_ABI = parseAbi([
  "function swapExactTokensForTokens(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient) returns (uint256)",
]);

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets,address receiver) returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Generate a random preimage and derive the predicted IntentAccount address
 * for it via `factory.predict`.
 */
export async function generateCredential(
  publicClient: PublicClient,
  factory: Hex,
): Promise<Credential> {
  const preimage = Fr.random();
  const salt = await poseidon2Hash([preimage]);
  const intentAddress = (await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "predict",
    args: [salt.toString() as Hex],
  })) as Hex;
  return { preimage, salt, intentAddress };
}

/**
 * Compute the sha256 commitment for a batch, matching
 * IntentAccount.executeBatch exactly:
 *   sha256(abi.encode(chainid, address(this), calls, nullifier))
 */
export function computeActionHash(
  chainId: bigint,
  intentAddress: Hex,
  calls: Call[],
  nullifier: Hex,
): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { type: "bytes32" },
    ],
    [chainId, intentAddress, calls, nullifier],
  );
  return sha256(encoded);
}

/**
 * Split a 32-byte hash into two 16-byte halves, each represented as a bytes32
 * with the 16 bytes in the low-order positions — the encoding the Noir circuit
 * expects for action_hash_hi / action_hash_lo (Noir's Field is 254 bits and
 * can't hold a full sha256 output).
 */
export function splitActionHash(hash: Hex): { hi: Hex; lo: Hex } {
  const raw = hash.slice(2);
  const hi = `0x${"0".repeat(32)}${raw.slice(0, 32)}` as Hex;
  const lo = `0x${"0".repeat(32)}${raw.slice(32, 64)}` as Hex;
  return { hi, lo };
}

/**
 * Initialize a UltraHonk backend from the compiled circuit artifact at
 * `circuits/intent/target/intent.json`. Callers must call `backend.bb.destroy()`
 * when finished to release the worker.
 */
export async function createBackend(options?: { threads?: number; circuitPath?: string }): Promise<BatchBackend> {
  const circuitPath =
    options?.circuitPath ?? resolve(process.cwd(), "circuits/intent/target/intent.json");
  const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));
  const bb = await Barretenberg.new({ threads: options?.threads ?? 1 });
  const backend = new UltraHonkBackend(circuit.bytecode, bb);
  return { circuit, backend, bb };
}

/**
 * Generate a UltraHonk proof for `calls` bound to `credential` and `nullifier`
 * on `chainId`. Returns raw bb.js ProofData; submission helpers below hex-encode
 * `.proof` for the EVM call.
 */
export async function proveBatch(params: {
  backend: BatchBackend;
  credential: Credential;
  calls: Call[];
  nullifier: Hex;
  chainId: bigint;
}): Promise<{ proof: ProofData; actionHash: Hex }> {
  const actionHash = computeActionHash(
    params.chainId,
    params.credential.intentAddress,
    params.calls,
    params.nullifier,
  );
  const { hi, lo } = splitActionHash(actionHash);

  const noir = new Noir(params.backend.circuit);
  const { witness } = await noir.execute({
    preimage: params.credential.preimage.toString(),
    salt: params.credential.salt.toString(),
    action_hash_hi: hi,
    action_hash_lo: lo,
  });
  const proof = await params.backend.backend.generateProof(witness, { verifierTarget: "evm" });
  return { proof, actionHash };
}

/**
 * Submit `deployAndExecuteBatch` on the factory. Deploys the clone lazily if
 * it isn't already, then runs the batch as the clone. Returns the tx hash.
 */
export async function deployAndExecuteBatch(params: {
  walletClient: WalletClient;
  factory: Hex;
  credential: Credential;
  calls: Call[];
  nullifier: Hex;
  proof: ProofData;
}): Promise<Hex> {
  return params.walletClient.writeContract({
    account: params.walletClient.account!,
    chain: params.walletClient.chain,
    address: params.factory,
    abi: FACTORY_ABI,
    functionName: "deployAndExecuteBatch",
    args: [
      params.credential.salt.toString() as Hex,
      params.calls,
      params.nullifier,
      ("0x" + Buffer.from(params.proof.proof).toString("hex")) as Hex,
    ],
  });
}

// ---------------------------------------------------------------------------
// Typed flow builders — pure, return Call[]
// ---------------------------------------------------------------------------

/** Single ERC20.transfer. One call. */
export function transferFlow(token: Hex, to: Hex, amount: bigint): Call[] {
  return [
    {
      target: token,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }),
    },
  ];
}

/**
 * approve(router, amountIn) + swapExactTokensForTokens(tokenIn, tokenOut, amountIn, minOut, recipient).
 * `recipient` can be any address — the intent account itself, the user's EOA,
 * another intent, etc. Two calls, one proof.
 */
export function swapAndSendFlow(params: {
  router: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Hex;
}): Call[] {
  return [
    {
      target: params.tokenIn,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [params.router, params.amountIn],
      }),
    },
    {
      target: params.router,
      value: 0n,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          params.tokenIn,
          params.tokenOut,
          params.amountIn,
          params.minAmountOut,
          params.recipient,
        ],
      }),
    },
  ];
}

/** approve(vault, amount) + vault.deposit(amount, receiver). Two calls, one proof. */
export function vaultDepositFlow(params: {
  vault: Hex;
  asset: Hex;
  amount: bigint;
  receiver: Hex;
}): Call[] {
  return [
    {
      target: params.asset,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [params.vault, params.amount],
      }),
    },
    {
      target: params.vault,
      value: 0n,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [params.amount, params.receiver],
      }),
    },
  ];
}

/** vault.redeem(shares, receiver, owner). Single call, one proof. */
export function vaultWithdrawFlow(params: {
  vault: Hex;
  shares: bigint;
  receiver: Hex;
  owner: Hex;
}): Call[] {
  return [
    {
      target: params.vault,
      value: 0n,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "redeem",
        args: [params.shares, params.receiver, params.owner],
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Convenience: default local public client, foundry chain id
// ---------------------------------------------------------------------------

export function localPublicClient(rpcUrl = "http://localhost:8545"): PublicClient {
  return createPublicClient({ chain: foundry, transport: http(rpcUrl) });
}

export const FOUNDRY_CHAIN_ID = BigInt(foundry.id);
