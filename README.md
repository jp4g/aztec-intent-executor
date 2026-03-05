# Aztec Private Intent Bridge

One-way bridge: send private tokens on Aztec localnet, receive equivalent ERC20 tokens on Anvil (local EVM).

## Architecture

```
User → private transfer on Aztec → ephemeral deposit address
                                          ↓
Bridge server polls balance every 5s → detects deposit
                                          ↓
Server mints equivalent ERC20 on Anvil → user receives tokens
```

## Prerequisites

- [Aztec Sandbox](https://docs.aztec.network/) running on `localhost:8080`
- [Anvil](https://book.getfoundry.sh/reference/anvil/) running on `localhost:8545`
- [Foundry](https://book.getfoundry.sh/) installed
- Node.js 18+ and Yarn

## Setup

```bash
# Install dependencies
yarn install

# Install Foundry libs
cd evm && forge install OpenZeppelin/openzeppelin-contracts && forge install foundry-rs/forge-std && cd ..

# Copy env and configure
cp .env.example .env
```

## Deploy EVM Contract

```bash
yarn evm:deploy
```

This deploys `BridgedUSDC` (bUSDC) to Anvil and writes the address to `evm-deployment.json`. Set the deployed address as `EVM_TOKEN_ADDRESS` in `.env`.

## Run

```bash
# Start the bridge server
yarn server
# Wait for "Fully initialized and ready!"

# In another terminal, run the integration test
yarn test:bridge
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Server status, token addresses, bridge state |
| `/api/faucet` | POST | Mint 1000 USDC (public) to an Aztec address |
| `/api/bridge/initiate` | POST | Create bridge session, returns deposit address |
| `/api/bridge/status/:aztecAddress` | GET | Check bridge session status |
| `/api/test/transfer-private` | POST | Server-side private mint to an address (testing) |

### Initiate Bridge

```bash
curl -X POST http://localhost:3001/api/bridge/initiate \
  -H "Content-Type: application/json" \
  -d '{"evmAddress": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}'
```

Returns an `aztecDepositAddress`. Send private USDC to that address within 5 minutes. The bridge detects the deposit and mints bUSDC on Anvil.

## Project Structure

```
├── evm/
│   ├── src/BridgedUSDC.sol       # ERC20 with onlyOwner mint, 6 decimals
│   └── script/Deploy.s.sol      # Forge deploy script
└── src/
    ├── config.ts                 # Localnet config constants
    ├── utils.ts                  # Aztec helpers (wallet, token, mint, transfer)
    ├── bridge.ts                 # AztecToEvmBridge class (polling + EVM minting)
    ├── server.ts                 # Express server + Aztec initialization
    └── test-bridge.ts            # Integration test script
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://localhost:8080` | Aztec sandbox URL |
| `EVM_RPC_URL` | `http://localhost:8545` | Anvil RPC URL |
| `EVM_PRIVATE_KEY` | Anvil account #0 | Key for minting on EVM |
| `EVM_TOKEN_ADDRESS` | — | Deployed BridgedUSDC address |
| `PORT` | `3001` | Server port |
