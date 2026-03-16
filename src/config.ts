/**
 * Bridge Configuration — supports localnet and production environments
 *
 * localnet:    Aztec localnet + Anvil (local EVM)
 * production:  Aztec devnet + Base Sepolia
 */

import { privateKeyToAccount } from "viem/accounts";

export const AZTEC_ENV = process.env.AZTEC_ENV || 'localnet';
export const IS_PRODUCTION = AZTEC_ENV === 'production';
export const IS_LOCALNET = AZTEC_ENV === 'localnet';

// Canonical SponsoredFPC addresses
const LOCALNET_FPC = '0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2';
const PRODUCTION_FPC = '0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2';

export const SPONSORED_FPC_ADDRESS = process.env.SPONSORED_FPC_ADDRESS || (IS_PRODUCTION ? PRODUCTION_FPC : LOCALNET_FPC);

export const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL || (IS_PRODUCTION ? 'https://v4-devnet-2.aztec-labs.com' : 'http://localhost:8080');
export const EVM_RPC_URL = process.env.EVM_RPC_URL || (IS_PRODUCTION ? 'https://sepolia.base.org' : 'http://localhost:8545');

// EVM chain selection: 'foundry' for Anvil, 'baseSepolia' for Base Sepolia
export const EVM_CHAIN_NAME = process.env.EVM_CHAIN || (IS_PRODUCTION ? 'baseSepolia' : 'foundry');

/**
 * Get the correct viem chain object based on EVM_CHAIN config.
 */
export async function getViemChain() {
  if (EVM_CHAIN_NAME === 'baseSepolia') {
    const { baseSepolia } = await import('viem/chains');
    return baseSepolia;
  }
  const { foundry } = await import('viem/chains');
  return foundry;
}

// Demo EVM account — derived from private key in env
export const DEMO_EVM_PRIVATE_KEY = process.env.DEMO_EVM_PRIVATE_KEY as `0x${string}` | undefined;
export const DEMO_EVM_ADDRESS = DEMO_EVM_PRIVATE_KEY
  ? privateKeyToAccount(DEMO_EVM_PRIVATE_KEY).address
  : undefined;

export function logConfig(): void {
  console.log('='.repeat(60));
  console.log('Aztec Private Intent Bridge - Configuration');
  console.log('='.repeat(60));
  console.log(`Environment: ${AZTEC_ENV}`);
  console.log(`Aztec Node URL: ${AZTEC_NODE_URL}`);
  console.log(`EVM RPC URL: ${EVM_RPC_URL}`);
  console.log(`EVM Chain: ${EVM_CHAIN_NAME}`);
  console.log(`Sponsored FPC: ${SPONSORED_FPC_ADDRESS}`);
  console.log(`Demo EVM Address: ${DEMO_EVM_ADDRESS || 'not configured'}`);
  console.log(`Prover enabled: ${IS_PRODUCTION}`);
  console.log('='.repeat(60));
}
