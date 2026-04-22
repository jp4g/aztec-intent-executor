# Aztec Private Intent Bridge

Bi-directional bridge between Aztec (private) and EVM. Send private tokens on Aztec, receive equivalent ERC20 tokens on EVM — and vice versa. Supports two deployment modes:

- **Localnet**: Aztec localnet + Anvil (local development)
- **Production**: Aztec devnet + Base Sepolia (real testnet)

On top of the token bridge, this repo also ships an **intent executor**: bridged bUSDC can be minted directly to a create2'd smart account on EVM whose actions are gated by a Noir proof of knowledge of the account's salt preimage. See [Intent Executor](#intent-executor) below.

## Architecture

```
Browser (Svelte app on :5173)              Server (Express on :3001)
├── EmbeddedWallet (own PXE)               ├── Faucet: mintTokensPrivate
├── Account from localStorage              ├── Forward bridge: Aztec→EVM
├── Private transfer (client-side)         ├── Reverse bridge: EVM→Aztec
├── Balance queries (client-side)          └── EVM transfer proxy (demo account)
└── Polls server APIs for bridge status

Aztec → EVM:
  User → private transfer → ephemeral deposit address
                                   ↓
  Bridge server polls balance → detects deposit → mints bUSDC on EVM

EVM → Aztec:
  User → sends bUSDC to bridge wallet on EVM
                                   ↓
  Bridge server detects deposit → mints private USDC on Aztec
```

## Prerequisites

- Node.js 18+ and Yarn
- [Foundry](https://book.getfoundry.sh/) installed

**For localnet:**
- [Aztec Sandbox](https://docs.aztec.network/) running on `localhost:8080`
- [Anvil](https://book.getfoundry.sh/reference/anvil/) running on `localhost:8545`

**For production:**
- A funded account on Base Sepolia (needs Sepolia ETH for gas)

## Setup

```bash
# Install dependencies
yarn install

# Install Foundry libs (first time only)
cd evm && forge install OpenZeppelin/openzeppelin-contracts && forge install foundry-rs/forge-std && cd ..
```

## Localnet

```bash
# 1. Start Anvil and Aztec Sandbox (separate terminals)
yarn anvil                  # anvil --code-size-limit 50000 --silent
aztec start --local-network # must match the @aztec/* SDK version in package.json

# 2. Deploy bUSDC to Anvil
yarn evm:deploy

# 3. (Optional — only needed for the intent executor demo)
yarn evm:deploy:mocks       # swap router, lending vault, second ERC20
yarn evm:deploy:intent

# 4. Start the bridge server
yarn server

# 5. Start the frontend (new terminal)
yarn dev
```

The Aztec CLI (`aztec`) must be the same version as `@aztec/aztec.js` in `package.json` — otherwise the sandbox rejects every SDK-built tx with `Invalid tx: Incorrect verification keys tree root`. At the time of writing both are `4.2.0-aztecnr-rc.2`; `aztec-up -v 4.2.0-aztecnr-rc.2` installs the matching CLI.

Open `http://localhost:5173`.

## Production (Aztec devnet + Base Sepolia)

### 1. Configure environment

Copy `.env.production` and fill in your keys:

```bash
cp .env.example .env.production
```

Edit `.env.production`:
```
AZTEC_ENV=production
AZTEC_NODE_URL=https://v4-devnet-2.aztec-labs.com
EVM_RPC_URL=https://sepolia.base.org
EVM_CHAIN=baseSepolia
EVM_PRIVATE_KEY=<your funded Base Sepolia private key>
DEMO_EVM_PRIVATE_KEY=<your demo account private key>
SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2
PORT=3001
```

### 2. Deploy bUSDC to Base Sepolia

```bash
yarn evm:deploy:base-sepolia
```

After deployment, add the contract address to `.env.production`:
```
EVM_TOKEN_ADDRESS=<deployed address>
```

### 3. Run

```bash
# Terminal 1: Start the bridge server
yarn server:production

# Terminal 2: Start the frontend
yarn dev:production
```

Open `http://localhost:5173`.

## Using the Demo

1. The app initializes automatically — connects to the server, creates an Aztec wallet in your browser, and deploys an account with SponsoredFPC
2. Click **"Get Test USDC"** to mint 1000 private USDC via the server faucet
3. **Aztec → EVM**: Enter an amount and click **"Bridge →"** — client-side private transfer to a deposit address, then the server mints bUSDC on EVM (~30s)
4. **EVM → Aztec**: Enter an amount and click **"← Bridge"** — the server transfers bUSDC from the demo account to the bridge wallet, then mints private USDC on Aztec (~30s)

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Server status, token addresses, bridge state |
| `/api/faucet` | POST | Mint 1000 USDC (public) to an Aztec address |
| `/api/faucet/private` | POST | Mint 1000 USDC (private) to an Aztec address |
| `/api/bridge/initiate` | POST | Create Aztec→EVM bridge session |
| `/api/bridge/status/:aztecAddress` | GET | Check forward bridge session status |
| `/api/bridge/evm-to-aztec` | POST | Create EVM→Aztec bridge session |
| `/api/bridge/evm-to-aztec/status/:sessionId` | GET | Check reverse bridge session status |
| `/api/demo/evm-balance` | GET | Query bUSDC balance of the demo EVM account |
| `/api/demo/transfer-evm-to-bridge` | POST | Transfer bUSDC from demo account to bridge |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_ENV` | `localnet` | `localnet` or `production` |
| `AZTEC_NODE_URL` | `http://localhost:8080` | Aztec node URL |
| `EVM_RPC_URL` | `http://localhost:8545` | EVM RPC URL |
| `EVM_CHAIN` | `foundry` | `foundry` (Anvil) or `baseSepolia` |
| `EVM_PRIVATE_KEY` | Anvil account #0 | Bridge operator key (mints bUSDC) |
| `DEMO_EVM_PRIVATE_KEY` | Anvil account #1 | Demo account for frontend |
| `EVM_TOKEN_ADDRESS` | from `evm-deployment.json` | Deployed BridgedUSDC address |
| `SPONSORED_FPC_ADDRESS` | canonical | Aztec SponsoredFPC address |
| `PORT` | `3001` | Server port |

## Scripts

| Script | Description |
|---|---|
| `yarn server` | Start server (localnet) |
| `yarn server:production` | Start server (production) |
| `yarn dev` | Start frontend (localnet) |
| `yarn dev:production` | Start frontend (production) |
| `yarn build` | Production webpack build |
| `yarn evm:deploy` | Deploy bUSDC to Anvil |
| `yarn evm:deploy:base-sepolia` | Deploy bUSDC to Base Sepolia |
| `yarn evm:deploy:mocks` | Deploy MockTokenB + MockSwapRouter (seeded) + MockLendingVault |
| `yarn evm:deploy:intent` | Deploy IntentVerifier + IntentAccount impl + factory to Anvil |
| `yarn evm:deploy:intent:base-sepolia` | Same, against Base Sepolia |
| `yarn evm:build` | Compile Solidity contracts |
| `yarn noir:build` | Compile the intent circuit and regenerate `IntentVerifier.sol` |
| `yarn test:bridge` | Run headless bridge integration test |
| `yarn test:intent` | Run headless intent-executor integration test |

## Project Structure

```
├── app/                          # Frontend (Svelte + TypeScript)
│   ├── main.ts                   # Entry point
│   ├── App.svelte                # Main UI component
│   ├── aztec-client.ts           # Browser-side Aztec client (EmbeddedWallet)
│   ├── index.html                # HTML template
│   └── style.css                 # Dark theme styles
├── evm/                          # Solidity contracts
│   ├── src/BridgedUSDC.sol       # ERC20 with onlyOwner mint, 6 decimals
│   └── script/Deploy.s.sol       # Forge deploy script
├── src/                          # Backend (Express + Aztec SDK)
│   ├── config.ts                 # Environment config (localnet/production)
│   ├── utils.ts                  # Aztec helpers (wallet, token, mint, transfer)
│   ├── bridge.ts                 # Bridge classes (forward + reverse)
│   ├── server.ts                 # Express server + API endpoints
│   └── test-bridge.ts            # Integration test script
├── circuits/intent/              # Noir circuit for intent proofs
│   ├── Nargo.toml
│   └── src/main.nr               # Poseidon2 preimage check + action-hash binding
├── .env.localnet                 # Localnet config (Aztec localnet + Anvil)
├── .env.production               # Production config (Aztec devnet + Base Sepolia)
├── .env.example                  # Template with all variables
├── webpack.config.js             # Webpack config (COOP/COEP, polyfills, proxy)
├── tsconfig.json                 # TypeScript config
└── package.json                  # Dependencies and scripts
```

## Intent Executor

A non-custodial executor layer on top of the token bridge. Bridged bUSDC lands at a create2'd smart account whose actions require a Noir proof of knowledge of the account's salt preimage — no private key, no EOA custody.

### Flow

```
1. Client generates random preimage, computes salt = Poseidon2(preimage)
2. Client derives intentAddr = Clones.predictDeterministicAddress(impl, salt, factory)
3. Client bridges bUSDC from Aztec to intentAddr (unchanged forward bridge)
4. Client builds Call[] (one or more (target, value, data) tuples) + a nullifier;
   actionHash = sha256(abi.encode(chainid, intentAddr, calls, nullifier))
5. Client generates one Noir proof with public inputs [salt, actionHashHi, actionHashLo]
6. Anyone calls factory.deployAndExecuteBatch(salt, calls, nullifier, proof)
   – deploys the EIP-1167 clone if not yet deployed
   – IntentAccount.executeBatch verifies the proof, re-hashes the batch, enforces
     the nullifier, and runs every call as itself (atomic — any failure reverts all)
```

**One proof per batch.** `Call = (address target, uint256 value, bytes data)`. The circuit doesn't care what's inside the batch — it only sees the 256-bit action hash split into two field halves — so arbitrary N-call flows all prove in identical time.

### Components

| File | Purpose |
|---|---|
| `circuits/intent/src/main.nr` | `Poseidon2(preimage) == salt`; `actionHash` bound as public input |
| `evm/src/IntentVerifier.sol` | UltraHonk verifier generated from the circuit's VK |
| `evm/src/IntentAccount.sol` | Per-salt EIP-1167 clone with `executeBatch(Call[], nullifier, proof)` and nullifier map |
| `evm/src/IntentAccountFactory.sol` | Deterministic deployer + `deployAndExecuteBatch` wrapper |
| `evm/src/MockTokenB.sol` | 18-dec ERC20 used as the swap counterparty in flow tests |
| `evm/src/MockSwapRouter.sol` | Fixed-rate two-token AMM; seeded with reserves at deploy |
| `evm/src/MockLendingVault.sol` | Minimal ERC4626-ish vault over bUSDC; shares 1:1, no yield |
| `evm/script/DeployIntent.s.sol` | Deploys verifier → impl → factory |
| `evm/script/DeployMocks.s.sol` | Deploys + seeds the three mock targets |
| `src/intent-client.ts` | SDK: credential gen, action-hash, proving, submission, typed flow builders |
| `src/test-intent.ts` | Headless end-to-end test (transfer + swap + vault deposit/withdraw + replay) |

### Flow builders (`src/intent-client.ts`)

Typed helpers that build the `Call[]` for each scenario. Each flow is one batch, one proof.

| Builder | Calls | Notes |
|---|---|---|
| `transferFlow(token, to, amount)` | 1 | ERC20 transfer |
| `swapAndSendFlow({ router, tokenIn, tokenOut, amountIn, minAmountOut, recipient })` | 2 | `approve(router)` + `swapExactTokensForTokens(…, recipient)` — atomic |
| `vaultDepositFlow({ vault, asset, amount, receiver })` | 2 | `approve(vault)` + `deposit(amount, receiver)` |
| `vaultWithdrawFlow({ vault, shares, receiver, owner })` | 1 | `redeem(shares, receiver, owner)` |

ERC-2612 permit doesn't help replace `approve` here: the caller is the `IntentAccount` (a contract) which can't produce ECDSA signatures. EIP-1271 contract signatures would work but would add circuit surface — the batched proof is the cleaner primitive.

### Rebuilding the circuit and verifier

```bash
yarn noir:build
```

This compiles the circuit with `nargo`, emits the VK with `bb write_vk`, and regenerates `evm/src/IntentVerifier.sol` via `bb write_solidity_verifier`. Then rerun `yarn evm:deploy:intent` to redeploy.

### Versioning

The proving stack must stay aligned or bb.js rejects the witness with `expected msgpack format marker (2 or 3), got 1`:

- `nargo 1.0.0-beta.19` at `$HOME/.nargo/bin/nargo` (`noirup -v 1.0.0-beta.19`). The `noir:build` script pins this path because `$HOME/.aztec/current/bin/nargo` is beta.18.
- `@noir-lang/noir_js@1.0.0-beta.19`
- `@aztec/bb.js@4.2.0-aztecnr-rc.2`

The `HonkVerifier` runtime bytecode is ~33.8 KB, which exceeds EIP-170. The `yarn anvil` script passes `--code-size-limit 50000` and the `evm:deploy:intent*` scripts pass `--disable-code-size-limit` so forge will broadcast it. Base Sepolia accepts contracts over 24 KB without extra flags.

### Running the integration test

With Anvil, the Aztec sandbox, and the bridge server running:

```bash
yarn evm:deploy           # bUSDC
yarn evm:deploy:mocks     # MockTokenB + MockSwapRouter (seeded) + MockLendingVault
yarn evm:deploy:intent    # verifier + impl + factory
yarn test:intent          # transfer, swap-and-send, vault deposit, vault withdraw, replay-reverts
```

The test bridges 100 bUSDC into a fresh intent account and runs all four flows against it — one nullifier per flow, all five assertions green.

### Caveats

- The circuit's `verifier` is immutable per intent account (set at init); evolving the circuit strands old accounts on old verifier bytecode. Fine for a demo; flag for prod.
- Nullifier is a user-chosen `bytes32`. Reuse reverts, so losing track of used nullifiers just wastes a tx — funds stay recoverable. Losing the preimage permanently locks the account.
- `MockLendingVault.redeem` requires `owner == msg.sender` (no ERC20 allowance machinery), so you can only redeem into your own intent account via a single-call batch. Real ERC4626 vaults typically accept an allowance-granted caller.

