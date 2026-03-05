/**
 * Bridge Configuration (Localnet only)
 */

// Canonical SponsoredFPC address (deployed at genesis with salt=0, same for all sandbox instances)
export const SPONSORED_FPC_ADDRESS = '0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2';

export const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL || 'http://localhost:8080';
export const EVM_RPC_URL = process.env.EVM_RPC_URL || 'http://localhost:8545';

export function logConfig(): void {
  console.log('='.repeat(60));
  console.log('Aztec Private Intent Bridge - Configuration');
  console.log('='.repeat(60));
  console.log(`Environment: localnet`);
  console.log(`Aztec Node URL: ${AZTEC_NODE_URL}`);
  console.log(`EVM RPC URL: ${EVM_RPC_URL}`);
  console.log(`Sponsored FPC: ${SPONSORED_FPC_ADDRESS}`);
  console.log('='.repeat(60));
}
