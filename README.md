# Aztec Private Intent Bridge

Bi-directional bridge between Aztec (private) and EVM. Send private tokens on Aztec, receive equivalent ERC20 tokens on EVM — and vice versa. Supports two deployment modes:

- **Localnet**: Aztec localnet + Anvil (local development)
- **Production**: Aztec devnet + Base Sepolia (real testnet)

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
anvil
aztec start --sandbox

# 2. Deploy canonical protocol contracts (SponsoredFPC etc.) — required on fresh sandbox
aztec setup-protocol-contracts --node-url http://localhost:8080

# 3. Deploy bUSDC to Anvil
yarn evm:deploy

# 4. Start the bridge server
yarn server

# 5. Start the frontend (new terminal)
yarn dev
```

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
| `yarn evm:build` | Compile Solidity contracts |
| `yarn test:bridge` | Run headless integration test |

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
├── .env.localnet                 # Localnet config (Aztec localnet + Anvil)
├── .env.production               # Production config (Aztec devnet + Base Sepolia)
├── .env.example                  # Template with all variables
├── webpack.config.js             # Webpack config (COOP/COEP, polyfills, proxy)
├── tsconfig.json                 # TypeScript config
└── package.json                  # Dependencies and scripts
```
