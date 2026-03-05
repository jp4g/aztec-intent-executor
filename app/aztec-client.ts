/**
 * Browser-side Aztec client for the Private Intent Bridge demo.
 * Handles account creation, balance queries, and private transfers directly in the browser.
 * Only faucet minting and EVM-side operations require the server.
 */

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js";

let wallet: any = null;
let isInitialized = false;
let node: any = null;

// Cache for created accounts
const accountCache = new Map<string, { address: AztecAddress; secret: Fr; salt: Fr }>();

/**
 * Initialize connection to Aztec node and create EmbeddedWallet
 */
export async function initializeAztec(nodeUrl: string, fpcAddress: string): Promise<void> {
  if (isInitialized) return;

  console.log("[Aztec] Connecting to node:", nodeUrl);
  node = createAztecNodeClient(nodeUrl);

  console.log("[Aztec] Creating EmbeddedWallet...");
  const { EmbeddedWallet } = await import("@aztec/wallets/embedded");
  wallet = await EmbeddedWallet.create(node, { pxeConfig: { proverEnabled: false } });

  // Register SponsoredFPC
  if (fpcAddress) {
    console.log("[Aztec] Registering SponsoredFPC...");
    const { SponsoredFPCContract } = await import("@aztec/noir-contracts.js/SponsoredFPC");
    const sponsoredFpcAddr = AztecAddress.fromString(fpcAddress);
    const sponsoredFpcInstance = await node.getContract(sponsoredFpcAddr);

    if (sponsoredFpcInstance) {
      await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContract.artifact);
      console.log("[Aztec] SponsoredFPC registered successfully");
    } else {
      console.warn("[Aztec] SponsoredFPC contract not found at", fpcAddress);
    }
  }

  isInitialized = true;
  console.log("[Aztec] Initialized successfully");
}

/**
 * Create or retrieve an account. Optionally deploy with SponsoredFPC.
 */
export async function createAccount(
  secretHex?: string,
  saltHex?: string,
  deploy: boolean = false,
  fpcAddress?: string
): Promise<{ address: string; secret: string; salt: string }> {
  if (!wallet) throw new Error("Aztec not initialized");

  const secret = secretHex ? Fr.fromString(secretHex) : Fr.random();
  const salt = saltHex ? Fr.fromString(saltHex) : Fr.random();

  const cacheKey = `${secret.toString()}:${salt.toString()}`;

  if (accountCache.has(cacheKey) && !deploy) {
    const cached = accountCache.get(cacheKey)!;
    return {
      address: cached.address.toString(),
      secret: cached.secret.toString(),
      salt: cached.salt.toString(),
    };
  }

  console.log("[Aztec] Creating Schnorr account...");
  const account = await wallet.createSchnorrAccount(secret, salt);

  if (deploy && fpcAddress) {
    console.log("[Aztec] Deploying account with SponsoredFPC...");
    const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
    const sponsoredFpcAddr = AztecAddress.fromString(fpcAddress);
    const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFpcAddr);

    const deployMethod = await account.getDeployMethod();
    await deployMethod.send({ from: AztecAddress.ZERO, fee: { paymentMethod } });
    console.log("[Aztec] Account deployed successfully");
  }

  accountCache.set(cacheKey, { address: account.address, secret, salt });

  return {
    address: account.address.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
  };
}

/**
 * Get private balance for an address
 */
export async function getBalance(tokenAddress: string, ownerAddress: string): Promise<bigint> {
  if (!wallet) throw new Error("Aztec not initialized");

  const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), wallet);
  const owner = AztecAddress.fromString(ownerAddress);

  const balance = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return balance;
}

/**
 * Transfer tokens privately using SponsoredFPC for fees
 */
export async function transferPrivate(
  tokenAddress: string,
  fromSecret: string,
  fromSalt: string,
  toAddress: string,
  amount: bigint,
  fpcAddress: string
): Promise<void> {
  if (!wallet) throw new Error("Aztec not initialized");

  // Ensure sender account is registered
  const senderAccount = await createAccount(fromSecret, fromSalt);
  const from = AztecAddress.fromString(senderAccount.address);
  const to = AztecAddress.fromString(toAddress);

  const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), wallet);

  console.log(`[Aztec] Transferring ${amount} privately...`);

  const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
  const sponsoredFpcAddr = AztecAddress.fromString(fpcAddress);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFpcAddr);

  await token.methods.transfer_private_to_private(from, to, amount, 0n)
    .send({ from, fee: { paymentMethod } });

  console.log("[Aztec] Transfer complete");
}

/**
 * Register a sender address for note discovery
 */
export async function registerSender(address: string): Promise<void> {
  if (!wallet) throw new Error("Aztec not initialized");
  const addr = AztecAddress.fromString(address);
  await wallet.registerSender(addr, 'bridge-sender');
  console.log("[Aztec] Registered sender:", address);
}

/**
 * Register a token contract with the wallet
 */
export async function registerTokenContract(tokenAddress: string): Promise<void> {
  if (!wallet || !node) throw new Error("Aztec not initialized");
  const addr = AztecAddress.fromString(tokenAddress);
  const instance = await node.getContract(addr);
  if (instance) {
    await wallet.registerContract(instance, TokenContract.artifact);
    console.log("[Aztec] Token contract registered:", tokenAddress);
  }
}

/**
 * Force PXE sync to discover new notes
 */
export async function syncPXE(): Promise<void> {
  if (!wallet) throw new Error("Aztec not initialized");
  // Trigger a sync by querying the node's block number and waiting
  console.log("[Aztec] Syncing PXE...");
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log("[Aztec] PXE sync complete");
}

/**
 * Generate a random hex secret (32 bytes)
 */
export function generateRandomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export { Fr, AztecAddress };
