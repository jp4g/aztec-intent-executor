# SponsoredFPC Registration on Localnet

## Problem

When setting up the SponsoredFPC on an Aztec sandbox (localnet), using `node.getContract(fpcAddress)` returns `null` — even though the FPC is deployed and functional on the sandbox.

This leads to the misleading conclusion that the canonical SponsoredFPC is not deployed, when it actually is.

## Root Cause

`node.getContract()` queries the node's **contract instance registry**, which is a specific lookup table. The canonical SponsoredFPC is deployed as part of the sandbox genesis/initialization and its bytecode exists in the **state tree**, but it is not registered in the instance registry that `getContract()` queries.

These are two separate things:
- Contract bytecode in the state tree (deployed, executable)
- Contract instance in the node's registry (a metadata lookup)

## Wrong Approach

```typescript
// This returns null even though the FPC is deployed and functional
const fpcInstance = await node.getContract(fpcAddr);
if (fpcInstance) {
  await wallet.registerContract(fpcInstance, SponsoredFPCContract.artifact);
}
```

## Correct Approach

As documented in the [Aztec fee payment guide](https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees), derive the address from the artifact and salt, then register it with the PXE:

```typescript
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';

const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
  SponsoredFPCContract.artifact,
  { salt: new Fr(0) },
);

await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);

const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);
```

This works because:
1. `getContractInstanceFromInstantiationParams` computes the deterministic address locally (artifact + salt)
2. `wallet.registerContract` tells the PXE about the contract's artifact so it can build transactions
3. When the transaction executes on-chain, the bytecode IS there in the state tree

## Verification

```typescript
// Both produce the same address: 0x09a4df73...caffb2
const derived = await getContractInstanceFromInstantiationParams(
  SponsoredFPCContract.artifact, { salt: new Fr(0) }
);
// Matches: aztec get-canonical-sponsored-fpc-address

// But node.getContract() can't find it
const fromNode = await node.getContract(derived.address); // null
```

## Applies To

- Aztec SDK `4.0.0-devnet.2-patch.1`
- Both localnet (sandbox) and devnet — the canonical FPC is pre-deployed on both
- The `aztec get-canonical-sponsored-fpc-address` CLI command computes the same address locally
