# Aztec Intent Executor

Bridge private USDC from Aztec to a **counterfactual create2 smart account on EVM**, then run arbitrary batched actions on that account gated by a Noir ZK proof — no EVM EOA, no private key on the EVM side.

## What it does

```
Aztec (private)                               EVM (Anvil or Base Sepolia)
─────────────────                             ────────────────────────────
user's private transfer                       bUSDC minted at the
→ ephemeral deposit note   ─── bridge ───→    counterfactual IntentAccount
                                              address (create2, not
                                              deployed yet)

                                              ↓

                                              user generates a Noir proof
                                              of knowledge of the salt's
                                              preimage, bound to a batch
                                              of EVM calls via sha256.

                                              factory.deployAndExecuteBatch
                                              lazily deploys the clone and
                                              runs the batch as it:
                                                - approve + swap
                                                - approve + vault deposit
                                                - redeem + swap + send
                                                - any (target,value,data)[]
```

No EVM signature ever authorizes anything — the proof is the authorization. The bridge is used only to get funds into the counterfactual address.

## Prerequisites

- Node.js 18+ and Yarn
- [Foundry](https://book.getfoundry.sh/)
- `aztec` CLI matching the SDK version in `package.json` (currently `4.2.0-aztecnr-rc.2`; install with `aztec-up -v 4.2.0-aztecnr-rc.2`). Version mismatch → `Invalid tx: Incorrect verification keys tree root`.
- `nargo 1.0.0-beta.19` at `$HOME/.nargo/bin/nargo` (`noirup -v 1.0.0-beta.19`) — only needed if you want to rebuild the circuit.

## Localnet quickstart

```bash
yarn install
cd evm && forge install OpenZeppelin/openzeppelin-contracts && forge install foundry-rs/forge-std && cd ..

cp .env.example .env.localnet      # defaults are fine for Anvil

# Terminal 1–2: infra
yarn anvil                         # anvil --code-size-limit 50000
aztec start --local-network

# Deploy
yarn evm:deploy                    # BridgedUSDC
yarn evm:deploy:mocks              # MockWETH, MockSwapRouter (seeded), 2x MockLendingVault
yarn evm:deploy:intent             # HonkVerifier, IntentAccount impl, IntentAccountFactory

# Terminal 3: bridge server
yarn server

# Terminal 4: run the headless end-to-end test
yarn test:intent
```

`test:intent` runs:

1. **Credential #1** — bridge 100 bUSDC, then transfer / replay-revert / swap / vault-deposit / vault-withdraw.
2. **Credential #2** — bridge 100 bUSDC, then a full **privacy round-trip** on one account:
   - tx1: approve + swap USDC → WETH (kept in intent)
   - tx2: approve + deposit WETH into the WETH vault
   - tx3: redeem + approve + swap WETH → USDC, recipient = reverse-bridge wallet
   - off-chain: reverse bridge detects the deposit and mints private USDC back on Aztec
   
   Net: private Aztec note → public EVM (swap/lend/unwind) → private Aztec note again. Three EVM batches on one reusable intent account, three distinct nullifiers, three proofs.

## Production (Aztec devnet + Base Sepolia)

Copy `.env.example` to `.env.production` and fill in:

```
AZTEC_ENV=production
AZTEC_NODE_URL=https://v4-devnet-2.aztec-labs.com
EVM_RPC_URL=https://sepolia.base.org
EVM_CHAIN=baseSepolia
EVM_PRIVATE_KEY=<your funded Base Sepolia key>
SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2
PORT=3001
```

Then `yarn evm:deploy:base-sepolia`, set `EVM_TOKEN_ADDRESS` in `.env.production`, `yarn evm:deploy:intent:base-sepolia`, and `yarn server:production`. Base Sepolia accepts the 33.8 KB HonkVerifier without EIP-170 flags.

## How the intent executor works

### Pieces

| File | Purpose |
|---|---|
| `circuits/intent/src/main.nr` | Noir circuit: `Poseidon2(preimage) == salt`, with `action_hash_hi` / `action_hash_lo` as bound public inputs |
| `evm/src/IntentVerifier.sol` | UltraHonk verifier generated from the circuit's VK |
| `evm/src/IntentAccount.sol` | Per-salt EIP-1167 clone. `executeBatch(Call[], nullifier, proof)` verifies + runs the batch |
| `evm/src/IntentAccountFactory.sol` | Deterministic deployer. `deployAndExecuteBatch` lazy-deploys the clone on first use |
| `evm/src/MockWETH.sol` | 18-decimal ERC20 standing in for wrapped ether |
| `evm/src/MockSwapRouter.sol` | Fixed-rate two-token AMM; seeded with bUSDC + WETH reserves at deploy |
| `evm/src/MockLendingVault.sol` | Minimal ERC4626-ish single-asset vault, shares 1:1, no yield |
| `src/intent-client.ts` | SDK: credential gen, action-hash, proving, submission, typed flow builders |
| `src/test-intent.ts` | Headless end-to-end integration test (uses the bridge + Aztec sandbox) |
| `evm/test/IntentAccount.t.sol` | Forge tests for the core security properties: tampered inputs, cross-account replay, reorder, re-init, duplicate deploy, replay, atomicity. Real proofs via FFI-cached `src/gen-fixture.ts` |
| `src/gen-fixture.ts` | CLI that generates + on-disk-caches a Noir proof for a given `(preimage, salt, action_hash_hi, action_hash_lo)`; the forge test shells out to it via `vm.ffi` |
| `src/bridge.ts` + `src/server.ts` | Bidirectional bridge: forward (`/api/bridge/initiate`, `/api/bridge/status/:addr`) + reverse (`/api/bridge/evm-to-aztec`, `/api/bridge/evm-to-aztec/status/:id`) |

### Flow

```
1. Client generates random preimage; salt = Poseidon2(preimage)
2. Client derives intentAddr = Clones.predictDeterministicAddress(impl, salt, factory)
3. Client bridges bUSDC from Aztec to intentAddr (forward bridge)
4. Client builds Call[] (arbitrary N) + a fresh nullifier;
   actionHash = sha256(abi.encode(chainid, intentAddr, calls, nullifier))
5. Client generates ONE Noir proof with public inputs [salt, actionHashHi, actionHashLo]
6. Anyone calls factory.deployAndExecuteBatch(salt, calls, nullifier, proof):
     - if intentAddr has no code, cloneDeterministic(salt) + initialize
     - IntentAccount.executeBatch: re-hashes on-chain, verifies proof, marks
       nullifier, loops calls[] as itself. Any call failing reverts all.
```

**One proof per batch.** The circuit only ever sees `[salt, hi, lo]` — so an N-call batch proves in the same time as a 1-call batch.

### Flow builders (`src/intent-client.ts`)

| Builder | Calls | Notes |
|---|---|---|
| `transferFlow(token, to, amount)` | 1 | ERC20 transfer |
| `swapAndSendFlow({ router, tokenIn, tokenOut, amountIn, minAmountOut, recipient })` | 2 | `approve(router)` + `swapExactTokensForTokens(…, recipient)` — atomic |
| `vaultDepositFlow({ vault, asset, amount, receiver })` | 2 | `approve(vault)` + `deposit(amount, receiver)` |
| `vaultWithdrawFlow({ vault, shares, receiver, owner })` | 1 | `redeem` (needs `owner == msg.sender`, i.e. the intent account) |

Concatenate them for bigger batches (e.g. `[...redeem, ...swapAndSend]` for the roundtrip's tx3). ERC-2612 permit can't replace the `approve`: the sender is a contract and can't produce ECDSA signatures; EIP-1271 would add circuit surface for no real benefit.

### Rebuilding the circuit

```bash
yarn noir:build
```

Compiles with `nargo`, emits the VK with `bb write_vk`, regenerates `evm/src/IntentVerifier.sol` via `bb write_solidity_verifier`. Rerun `yarn evm:deploy:intent` after.

**Version alignment** — mismatches here cause `expected msgpack format marker (2 or 3), got 1` at proof time:

- `nargo 1.0.0-beta.19` (the `noir:build` script pins `$HOME/.nargo/bin/nargo` because `$HOME/.aztec/current/bin/nargo` is beta.18)
- `@noir-lang/noir_js@1.0.0-beta.19`
- `@aztec/bb.js@4.2.0-aztecnr-rc.2`

The `HonkVerifier` runtime bytecode is ~33.8 KB, over EIP-170. `yarn anvil` passes `--code-size-limit 50000` and `evm:deploy:intent*` passes `--disable-code-size-limit`.

### Caveats

- The verifier is immutable per intent account (set at init); circuit upgrades strand old accounts on old verifier bytecode. Fine for a demo.
- Nullifier is a user-chosen `bytes32`; accidental reuse just wastes a tx. Losing the preimage permanently locks the account.
- The bridge operator sees the destination EVM address (the counterfactual `intentAddr`) and the Aztec side of the reverse bridge, so the round-trip isn't end-to-end unlinkable from the operator's viewpoint. On-chain observers only see the intent account as a create2 address with no direct link to either Aztec endpoint.

## Scripts

| Script | Description |
|---|---|
| `yarn anvil` | Anvil on :8545 with `--code-size-limit 50000` |
| `yarn server` / `yarn server:production` | Bridge server (localnet / Base Sepolia) |
| `yarn evm:deploy` / `yarn evm:deploy:base-sepolia` | Deploy bUSDC |
| `yarn evm:deploy:mocks` | Deploy MockWETH + swap router (seeded) + two lending vaults |
| `yarn evm:deploy:intent` / `yarn evm:deploy:intent:base-sepolia` | Deploy verifier + impl + factory |
| `yarn evm:build` | `forge build` |
| `yarn noir:build` | Recompile circuit + regenerate `IntentVerifier.sol` |
| `yarn test:intent` | Run the headless end-to-end integration test (uses the live bridge) |
| `yarn test:security` | `forge test` — 11 security cases (tampered inputs, cross-account replay, re-init, atomicity, etc). Real proofs via FFI-cached `src/gen-fixture.ts`; no anvil, no bridge |
| `yarn test:circuit` | Proof pipeline sanity check (no bridge, no anvil) |

## API (server)

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Server status, Aztec + EVM token addresses, both bridge states |
| `/api/bridge/initiate` | POST | Start an Aztec→EVM forward bridge session targeting any EVM address (including a counterfactual intent account) |
| `/api/bridge/status/:aztecAddress` | GET | Poll a forward bridge session by its Aztec deposit address |
| `/api/bridge/evm-to-aztec` | POST | Start an EVM→Aztec reverse bridge session — used when an intent batch wants proceeds delivered back privately to an Aztec address |
| `/api/bridge/evm-to-aztec/status/:sessionId` | GET | Poll a reverse bridge session |
| `/api/test/transfer-private` | POST | Test helper — mint private USDC directly to an Aztec address |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_ENV` | `localnet` | `localnet` or `production` |
| `AZTEC_NODE_URL` | `http://localhost:8080` (localnet) | Aztec node URL |
| `EVM_RPC_URL` | `http://localhost:8545` (localnet) | EVM RPC |
| `EVM_CHAIN` | `foundry` (localnet) | `foundry` or `baseSepolia` |
| `EVM_PRIVATE_KEY` | Anvil account #0 | Bridge operator / deployer key |
| `EVM_TOKEN_ADDRESS` | from `evm-deployment.json` | Deployed BridgedUSDC address |
| `SPONSORED_FPC_ADDRESS` | canonical | Aztec SponsoredFPC |
| `PORT` | `3001` | Server port |

## Project layout

```
├── evm/
│   ├── src/BridgedUSDC.sol           # 6-dec ERC20, onlyOwner mint
│   ├── src/IntentAccount.sol         # executeBatch(Call[], nullifier, proof)
│   ├── src/IntentAccountFactory.sol  # create2 + deployAndExecuteBatch
│   ├── src/IntentVerifier.sol        # UltraHonk verifier (generated)
│   ├── src/MockWETH.sol
│   ├── src/MockSwapRouter.sol
│   ├── src/MockLendingVault.sol
│   └── script/
│       ├── Deploy.s.sol              # bUSDC
│       ├── DeployMocks.s.sol         # WETH, router, two vaults
│       └── DeployIntent.s.sol        # verifier + impl + factory
├── circuits/intent/
│   ├── Nargo.toml
│   └── src/main.nr                   # Poseidon2 preimage + action_hash binding
├── src/
│   ├── config.ts                     # env + chain selection
│   ├── utils.ts                      # Aztec wallet/token helpers
│   ├── bridge.ts                     # AztecToEvmBridge (forward only)
│   ├── server.ts                     # Express server (4 endpoints)
│   ├── intent-client.ts              # SDK: credential, proving, submission, flow builders
│   ├── test-intent.ts                # headless end-to-end test
│   └── test-circuit.ts               # proof-pipeline sanity check
├── .env.localnet / .env.production / .env.example
├── tsconfig.json
└── package.json
```
