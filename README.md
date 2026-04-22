# Aztec Intent Executor

Bridge private USDC from Aztec to a **counterfactual create2 smart account on EVM**, run arbitrary batched actions on that account gated by a single Noir ZK proof, then optionally bridge proceeds back to Aztec privately. No EVM EOA, no private key ever signs on the EVM side — the proof is the authorization.

```
Aztec (private)                               EVM (Anvil or Base Sepolia)
─────────────────                             ────────────────────────────
userAztec → ephemeral deposit  ── bridge ──→  bUSDC minted at counterfactual
  (private Aztec transfer)                    IntentAccount (create2 address,
                                              not deployed yet)

                                              user generates ONE Noir proof
                                              of knowledge of the salt's
                                              preimage, bound via sha256 to
                                              an arbitrary Call[] batch.

                                              factory.deployAndExecuteBatch
                                              lazy-deploys the clone and runs
                                              the batch as itself — atomic.
                                              Reusable across many batches
                                              under distinct nullifiers.

destination Aztec note  ← reverse bridge ←    intent account delivers final
  (privately minted)                          USDC to the reverse-bridge
                                              wallet; matched by amount.
```

## Prerequisites

- Node.js 18+, Yarn
- [Foundry](https://book.getfoundry.sh/) (`forge`, `anvil`, `cast`)
- `aztec` CLI matching the SDK version in `package.json`. At time of writing both pinned to `4.2.0-aztecnr-rc.2` — install with `aztec-up -v 4.2.0-aztecnr-rc.2`. A mismatch causes every SDK-built tx to be rejected as `Invalid tx: Incorrect verification keys tree root`.
- `nargo 1.0.0-beta.19` at `$HOME/.nargo/bin/nargo` (`noirup -v 1.0.0-beta.19`) — only needed if you rebuild the Noir circuit.

## Localnet quickstart

```bash
yarn install
cd evm && forge install OpenZeppelin/openzeppelin-contracts && forge install foundry-rs/forge-std && cd ..

cp .env.example .env.localnet

# Terminals 1–2: infra
yarn anvil                         # anvil --code-size-limit 50000 --silent
aztec start --local-network

# Deploy (order matters — bUSDC first, mocks+intent in either order)
yarn evm:deploy                    # BridgedUSDC
yarn evm:deploy:mocks              # MockWETH + MockSwapRouter (seeded) + 2× MockLendingVault
yarn evm:deploy:intent             # HonkVerifier + IntentAccount impl + IntentAccountFactory

# Terminal 3: bridge server
yarn server

# Terminal 4: run the end-to-end test
yarn test:intent
```

`yarn test:intent` runs two independent sessions:

1. **Primitives** (credential A) — bridge 100 bUSDC, then transfer / replay-revert / swap / bUSDC-vault deposit / bUSDC-vault withdraw.
2. **Privacy roundtrip** (credential B) — bridge another 100 bUSDC, then three batches on one reusable intent account:
   - tx1: `approve + swap` USDC → WETH (kept in the intent)
   - tx2: `approve + deposit` WETH into the WETH vault
   - tx3: `redeem + approve + swap` WETH → USDC, delivered to the reverse-bridge wallet
   - off-chain: reverse bridge detects the deposit (matched by amount) and mints private USDC back on Aztec
   
   Net path: private Aztec note → public EVM (swap / lend / unwind) → private Aztec note again. Three nullifiers, three proofs, one intent account.

`yarn test:security` runs the forge test suite — 11 cases pinning the proof-binding + contract-logic invariants (details below). No anvil or Aztec sandbox needed.

## Production (Aztec devnet + Base Sepolia)

Copy `.env.example` → `.env.production` and fill in:

```
AZTEC_ENV=production
AZTEC_NODE_URL=https://v4-devnet-2.aztec-labs.com
EVM_RPC_URL=https://sepolia.base.org
EVM_CHAIN=baseSepolia
EVM_PRIVATE_KEY=<funded Base Sepolia key, also receives reverse-bridge deposits>
SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2
PORT=3001
```

Then `yarn evm:deploy:base-sepolia`, set `EVM_TOKEN_ADDRESS` in `.env.production`, `yarn evm:deploy:intent:base-sepolia`, `yarn server:production`. Base Sepolia accepts the 33.8 KB `HonkVerifier` runtime code without EIP-170 flags.

## How the intent executor works

### Pieces

| File | Purpose |
|---|---|
| `circuits/intent/src/main.nr` | Noir circuit: `Poseidon2(preimage) == salt`, with `action_hash_hi` / `action_hash_lo` as bound public inputs |
| `evm/src/IntentVerifier.sol` | UltraHonk verifier, generated from the circuit's VK via `bb write_solidity_verifier` |
| `evm/src/IntentAccount.sol` | Per-salt EIP-1167 clone. `executeBatch(Call[], nullifier, proof)` verifies the proof and runs every call as itself (atomic) |
| `evm/src/IntentAccountFactory.sol` | Deterministic deployer. `deployAndExecuteBatch` lazy-deploys the clone on first use |
| `evm/src/BridgedUSDC.sol` | 6-decimal ERC20, onlyOwner mint (bridge operator holds the owner key) |
| `evm/src/MockWETH.sol` | 18-decimal ERC20 standing in for wrapped ether — swap counterparty |
| `evm/src/MockSwapRouter.sol` | Fixed-rate two-token AMM; deploy script seeds bUSDC + WETH reserves at 1:1 |
| `evm/src/MockLendingVault.sol` | Minimal ERC4626-ish single-asset vault, shares 1:1, no yield; deployed once per asset |
| `src/intent-client.ts` | Client SDK — credential gen, action-hash, proving, submission, typed flow builders |
| `src/bridge.ts` | `AztecToEvmBridge` (forward, session-per-deposit) + `EvmToAztecBridge` (reverse, amount-matched sessions) |
| `src/server.ts` | Express server exposing the 6 bridge / test endpoints |
| `src/test-intent.ts` | Headless end-to-end test (uses the live bridge + Aztec sandbox) |
| `evm/test/IntentAccount.t.sol` | Forge test — 11 security cases. Real proofs via `vm.ffi` into `src/gen-fixture.ts`, cached on disk |
| `src/gen-fixture.ts` | CLI that generates + caches a Noir proof for a given `(preimage, salt, action_hash_hi, action_hash_lo)` |
| `src/test-circuit.ts` | Proof-pipeline sanity check — no bridge, no anvil, no forge |

### Flow (one batch)

```
1. Client generates random preimage; salt = Poseidon2(preimage)
2. intentAddr = Clones.predictDeterministicAddress(impl, salt, factory)
3. Bridge bUSDC from Aztec to intentAddr (forward bridge)
4. Build Call[] (arbitrary N) + a fresh bytes32 nullifier;
   actionHash = sha256(abi.encode(chainid, intentAddr, calls, nullifier))
5. Generate ONE Noir proof with public inputs [salt, actionHashHi, actionHashLo]
6. Anyone submits factory.deployAndExecuteBatch(salt, calls, nullifier, proof):
     - if intentAddr has no code: cloneDeterministic(salt) + initialize
     - IntentAccount.executeBatch: re-hashes on-chain, verifies proof,
       marks nullifier, executes every call as itself. Any failing call
       reverts the whole batch.
```

**One proof per batch.** The circuit only ever sees `[salt, hi, lo]` — so an N-call batch proves in the same time as a 1-call batch.

**Reusable account.** Every batch consumes its own nullifier from an on-chain map. The same intent account can run unlimited distinct batches under the same salt.

### Flow builders (`src/intent-client.ts`)

| Builder | Calls | Notes |
|---|---|---|
| `transferFlow(token, to, amount)` | 1 | ERC20 transfer |
| `swapAndSendFlow({ router, tokenIn, tokenOut, amountIn, minAmountOut, recipient })` | 2 | `approve(router)` + `swapExactTokensForTokens` — atomic |
| `vaultDepositFlow({ vault, asset, amount, receiver })` | 2 | `approve(vault)` + `deposit(amount, receiver)` |
| `vaultWithdrawFlow({ vault, shares, receiver, owner })` | 1 | `redeem` (needs `owner == msg.sender`, i.e. the intent account) |

Concatenate for bigger batches (e.g. `[...redeem, ...swapAndSend]` for the roundtrip's tx3).

**ERC-2612 permit doesn't help replace `approve`** — the caller is the `IntentAccount` (a contract), which can't produce ECDSA signatures. EIP-1271 contract signatures would work but add circuit surface for no real benefit over a batched proof.

### Rebuilding the circuit

```bash
yarn noir:build
```

Compiles with `nargo`, emits the VK with `bb write_vk`, regenerates `evm/src/IntentVerifier.sol`. Rerun `yarn evm:deploy:intent` after.

**Version alignment** — mismatches here cause `expected msgpack format marker (2 or 3), got 1` at proof time:

- `nargo 1.0.0-beta.19` — the `noir:build` script pins `$HOME/.nargo/bin/nargo` because `$HOME/.aztec/current/bin/nargo` is beta.18.
- `@noir-lang/noir_js@1.0.0-beta.19`
- `@aztec/bb.js@4.2.0-aztecnr-rc.2`

The `HonkVerifier` runtime bytecode is ~33.8 KB, over EIP-170. `yarn anvil` uses `--code-size-limit 50000` and `evm:deploy:intent*` passes `--disable-code-size-limit` to forge.

## Tests

### Forge (`yarn test:security`)

`evm/test/IntentAccount.t.sol` — 11 cases, all green. Run `forge test` from `evm/` or `yarn test:security` from the repo root. No bridge, no anvil; proofs generated by `src/gen-fixture.ts` via `vm.ffi` and cached under `evm/test/fixtures/cache/` (keyed by circuit bytecode + inputs, invalidates on circuit rebuild).

| Test | Asserts |
|---|---|
| `test_EmptyBatch_Reverts` | `executeBatch(calls=[])` → `EmptyBatch()` |
| `test_TamperedTarget_Reverts` | Submitting the canonical proof with a mutated `calls[0].target` → verifier rejection |
| `test_TamperedValue_Reverts` | …mutated `calls[0].value` → rejection |
| `test_TamperedData_Reverts` | …flipped byte of `calls[0].data` → rejection |
| `test_TamperedNullifier_Reverts` | …mutated nullifier → rejection |
| `test_ReorderedCalls_Reverts` | Proof on `[A,B]` submitted with `[B,A]` → rejection |
| `test_CrossAccountReplay_Reverts` | Proof made on intentA submitted against intentB → rejection |
| `test_ReInit_Reverts` | Direct `initialize()` on a deployed clone → `InvalidInitialization()` |
| `test_DuplicateDeploy_Reverts` | `factory.deploy(salt)` twice for same salt → OZ `FailedDeployment()` |
| `test_Replay_Reverts` | Second `executeBatch` with an already-used nullifier → `Replay(nullifier)` |
| `test_CallLevelAtomicity_Rolls_Back` | Batch where call 2 reverts (balance too low) → whole tx reverts, call 1's transfer rolled back |

Cold run: ~1.1 s (generates 4 unique proofs). Warm: ~0.8 s (all cache hits).

Observation worth knowing: real-world bad-proof reverts fire as **`SumcheckFailed()`** from `HonkVerifier`, not our wrapper `InvalidProof()`. The wrapper only fires if `verify()` returns `false`, but the generated UltraHonk verifier reverts directly on mismatch instead.

### End-to-end (`yarn test:intent`)

`src/test-intent.ts` — runs against the live anvil + Aztec sandbox + bridge server. Exercises everything including the real Aztec↔EVM bridging. ~50 s start to finish. See "Localnet quickstart" above for the scenarios covered.

### Proof pipeline sanity (`yarn test:circuit`)

`src/test-circuit.ts` — no bridge, no anvil. Just: generate a preimage, compute salt, generate a witness, run the prover, verify off-chain. Quickest smoke check that `nargo` + `noir_js` + `bb.js` are aligned.

## API (server)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Server status + bUSDC / bridge / FPC addresses / reverse-bridge deposit address |
| `/api/bridge/initiate` | POST | Open an Aztec→EVM forward session targeting any EVM address (typically a counterfactual `intentAddr`) |
| `/api/bridge/status/:aztecAddress` | GET | Poll a forward session by its Aztec deposit address |
| `/api/bridge/evm-to-aztec` | POST | Open an EVM→Aztec reverse session — mints private USDC to a specified Aztec address once the bridge wallet receives the amount |
| `/api/bridge/evm-to-aztec/status/:sessionId` | GET | Poll a reverse session by its session id |
| `/api/test/transfer-private` | POST | Test helper — server-side private mint of USDC directly to an Aztec address. Used by `test-intent.ts` to populate deposit addresses; not a user-facing API |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_ENV` | `localnet` | `localnet` or `production` |
| `AZTEC_NODE_URL` | `http://localhost:8080` (localnet) | Aztec node URL |
| `EVM_RPC_URL` | `http://localhost:8545` (localnet) | EVM RPC |
| `EVM_CHAIN` | `foundry` (localnet) | `foundry` or `baseSepolia` |
| `EVM_PRIVATE_KEY` | Anvil account #0 | Bridge operator / deployer key (also receives reverse-bridge deposits) |
| `EVM_TOKEN_ADDRESS` | from `evm-deployment.json` | Deployed `BridgedUSDC` address |
| `SPONSORED_FPC_ADDRESS` | canonical | Aztec SponsoredFPC |
| `PORT` | `3001` | Server port |

## Scripts

| Script | Description |
|---|---|
| `yarn anvil` | Anvil on `:8545` with `--code-size-limit 50000 --silent` |
| `yarn server` / `yarn server:production` | Bridge server (localnet / Base Sepolia) |
| `yarn evm:deploy` / `yarn evm:deploy:base-sepolia` | Deploy `BridgedUSDC` |
| `yarn evm:deploy:mocks` | Deploy `MockWETH` + `MockSwapRouter` (seeded) + two `MockLendingVault` instances |
| `yarn evm:deploy:intent` / `yarn evm:deploy:intent:base-sepolia` | Deploy verifier + impl + factory |
| `yarn evm:build` | `forge build` |
| `yarn noir:build` | Recompile circuit + regenerate `IntentVerifier.sol` |
| `yarn test:intent` | End-to-end integration test (needs bridge + Aztec sandbox + anvil) |
| `yarn test:security` | `forge test` from `evm/` — 11 security cases, no external deps |
| `yarn test:circuit` | Proof pipeline sanity check |

## Privacy & trust model

What this system actually hides, and from whom.

| Observer | Can link | Via |
|---|---|---|
| Aztec chain observer | nothing directly | Aztec transfers are private |
| EVM chain observer | `intentAddr ↔ bridgeWallet` deposit, on-chain batch calls, final delivery | Public EVM state |
| EVM chain observer (inferentially) | forward bridge deposit ↔ reverse bridge delivery | **Exact amount matching** between sessions |
| Submitter's EOA | `senderEoa ↔ intentAddr` | `msg.sender` of `deployAndExecuteBatch` |
| **Bridge operator** | `userAztec → intentAddr → finalAztec` (end-to-end) | API payloads + note decryption |

**The big one:** the bridge operator sees the full mapping. The operator holds:
1. The Aztec-side key that decrypts deposit notes at each session's ephemeral `depositAddr` (needed because the token standard uses sender-aware note discovery, so `POST /api/bridge/initiate` has to pass `senderAddress: userAztec`).
2. The EVM-side key that actually calls `bUSDC.mint`.

Whoever runs the server can trivially correlate `userAztec → intentAddr` on the forward leg and `intentAddr → finalAztec` on the reverse leg. This is a structural property of the custodial design, not a bug.

**Cheap mitigations available in the current code:**
- **Relayer-submit the intent tx.** Any EOA can submit `deployAndExecuteBatch` — the proof is the authorization, not `msg.sender`. A relayer hides the user's EOA from EVM chain observers.
- **Fresh intent account per flow.** The scheme makes this free — new random preimage → new salt → new create2 address. Limits on-chain linkability to per-flow, not per-user.
- **Break amount equality.** Round amounts down on the reverse bridge, or leave dust in the intent account, so forward and reverse sessions don't share the same value. Makes on-chain correlation inferential rather than exact.

**Architectural mitigations (not implemented here):**
- Drop `senderAddress` from `/api/bridge/initiate` by using a stealth-address / ephemeral-key Aztec token primitive — the operator never learns `userAztec`.
- Pooled / mixed bridge model — all deposits go through one shielded pool, withdrawals are gated by a ZK proof-of-prior-deposit rather than a server-side session lookup. Operator sees the aggregate but can't map user to intent.
- Threshold / MPC operator — split the EVM mint key among an N-of-M committee. Reduces unilateral mint power; doesn't hide identity on its own.
- Native Aztec L1↔L2 portal for the EVM side — makes the mint permissionless (Merkle-proof-of-Aztec-burn), but practically forces you to target Ethereum L1 rather than Base.

### Other caveats

- The verifier is immutable per intent account (set at `initialize`); circuit upgrades strand old accounts on old verifier bytecode. Fine for a demo, flag for prod.
- Nullifier is a user-chosen `bytes32`. Accidental reuse just wastes a tx — funds stay recoverable at the intent address. Losing the preimage permanently locks the account.
- `MockLendingVault.redeem` requires `owner == msg.sender` (no ERC20-allowance machinery), so you can only redeem into the intent account via a single-call batch. Real ERC4626 vaults typically support allowance-granted redemptions.

## Project layout

```
├── circuits/intent/
│   ├── Nargo.toml
│   └── src/main.nr                       # Poseidon2 preimage + action_hash binding
├── evm/
│   ├── foundry.toml                      # ffi = true for the fixture generator
│   ├── src/
│   │   ├── BridgedUSDC.sol               # 6-dec ERC20, onlyOwner mint
│   │   ├── IntentAccount.sol             # executeBatch(Call[], nullifier, proof)
│   │   ├── IntentAccountFactory.sol      # create2 + deployAndExecuteBatch
│   │   ├── IntentVerifier.sol            # UltraHonk verifier (generated)
│   │   ├── MockWETH.sol
│   │   ├── MockSwapRouter.sol
│   │   └── MockLendingVault.sol
│   ├── script/
│   │   ├── Deploy.s.sol                  # bUSDC
│   │   ├── DeployMocks.s.sol             # WETH + router + two vaults
│   │   └── DeployIntent.s.sol            # verifier + impl + factory
│   └── test/
│       ├── IntentAccount.t.sol           # 11 security tests
│       └── fixtures/cache/               # gitignored: cached proof hex (FFI output)
├── src/
│   ├── config.ts                         # env + chain selection
│   ├── utils.ts                          # Aztec wallet / token helpers
│   ├── bridge.ts                         # forward + reverse bridge classes
│   ├── server.ts                         # Express server (6 endpoints)
│   ├── intent-client.ts                  # SDK: credential, proving, submission, flow builders
│   ├── gen-fixture.ts                    # CLI used by forge vm.ffi for real proofs
│   ├── test-intent.ts                    # end-to-end test (uses live bridge)
│   └── test-circuit.ts                   # proof pipeline sanity
├── .env.localnet / .env.production / .env.example
├── tsconfig.json
└── package.json
```
