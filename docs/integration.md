# Third-Party Integration Guide

## Overview

The Aztec Private Intent Bridge enables bidirectional token bridging between Aztec (private) and EVM (public) chains. It supports two flows:

- **Aztec → EVM**: User sends private USDC on Aztec, receives bUSDC on EVM
- **EVM → Aztec**: User sends bUSDC on EVM, receives private USDC on Aztec

### Architecture

```
┌─────────────┐                    ┌──────────────────┐                    ┌─────────────┐
│  Aztec L2    │  ◄── private ───► │  Bridge Server   │  ◄── ERC20 ────►  │   EVM Chain  │
│  (Private    │     transfer      │  (Express API)   │     mint/watch    │  (Anvil /    │
│   USDC)      │                   │                  │                    │   Base Sep.) │
└─────────────┘                    └──────────────────┘                    └─────────────┘
```

The bridge server acts as a trusted intermediary:
- For **Aztec→EVM**: creates ephemeral Aztec accounts, detects private deposits, mints bUSDC on EVM
- For **EVM→Aztec**: watches an EVM deposit address for bUSDC transfers, mints private USDC on Aztec

## Prerequisites

- A running bridge server instance
- The following NPM packages:

```bash
# Aztec packages (all must be the same version)
npm install @aztec/aztec.js@4.0.0-devnet.2-patch.1 \
            @aztec/accounts@4.0.0-devnet.2-patch.1 \
            @aztec/pxe@4.0.0-devnet.2-patch.1 \
            @aztec/wallets@4.0.0-devnet.2-patch.1 \
            @aztec/foundation@4.0.0-devnet.2-patch.1

# Token contract artifacts
npm install @defi-wonderland/aztec-standards@4.0.0-devnet.2-patch.1

# EVM interactions
npm install viem@^2.44.4
```

> **Version note:** All `@aztec/*` and `@defi-wonderland/aztec-standards` packages must use the same version. Mixing versions will cause runtime errors.

## Discovery — `GET /api/health`

Call the health endpoint to retrieve all addresses, config, and connection info needed for integration.

```typescript
const res = await fetch("http://localhost:3001/api/health");
const config = await res.json();
```

### Response Fields

| Field | Description |
|-------|-------------|
| `status` | `"ok"` when ready, `"initializing"` during startup |
| `tokenAddress` | Aztec USDC contract address (for balance queries, transfers) |
| `minterAddress` | Bridge server's minter account — register as sender for note discovery (EVM→Aztec flow) |
| `evmTokenAddress` | bUSDC ERC20 contract address on EVM |
| `sponsoredFpcAddress` | SponsoredFPC address for fee payment on Aztec |
| `nodeUrl` | Aztec node URL (for client-side PXE/wallet setup) |
| `evmRpcUrl` | EVM RPC URL (for wallet/provider config) |
| `evmChainId` | EVM chain ID (e.g., `31337` for Anvil, `84532` for Base Sepolia) |
| `evmChainName` | EVM chain name (`"foundry"` or `"baseSepolia"`) |
| `bridgeEnabled` | Whether Aztec→EVM bridge is active |
| `reverseBridgeEnabled` | Whether EVM→Aztec bridge is active |
| `reverseBridgeDepositAddress` | EVM address to send bUSDC to for EVM→Aztec bridging |
| `environment` | `"localnet"` or `"production"` |

## Aztec → EVM Bridge

Bridge private USDC from Aztec to bUSDC on an EVM chain.

### Flow

1. Call `POST /api/bridge/initiate` with the destination EVM address and your Aztec sender address
2. The server returns an ephemeral Aztec deposit address
3. Transfer private USDC to that deposit address on Aztec
4. The bridge detects the deposit and mints bUSDC on EVM
5. Poll `GET /api/bridge/status/:aztecAddress` to track progress

### Step-by-Step (TypeScript)

```typescript
import { createPXEClient, waitForPXE } from "@aztec/pxe/client";

// 1. Get bridge config
const healthRes = await fetch("http://localhost:3001/api/health");
const config = await healthRes.json();

// 2. Set up Aztec PXE client using nodeUrl from health
const pxe = await createPXEClient(config.nodeUrl);
await waitForPXE(pxe);

// 3. Initiate bridge session
const initiateRes = await fetch("http://localhost:3001/api/bridge/initiate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    evmAddress: "0xYourEvmAddress",
    senderAddress: userAztecWallet.getAddress().toString(), // critical for note discovery
  }),
});
const session = await initiateRes.json();
// session.aztecDepositAddress — send tokens here
// session.expiresAt — must complete before this timestamp

// 4. Transfer private USDC to the deposit address
const { TokenContract } = await import(
  "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js"
);
const token = TokenContract.at(config.tokenAddress, userAztecWallet);

const depositAddress = AztecAddress.fromString(session.aztecDepositAddress);
const amount = 100n * 1_000_000n; // 100 USDC (6 decimals)

await token.methods
  .transfer_to_private(depositAddress, amount)
  .send()
  .wait();

// 5. Poll for completion
const pollStatus = async () => {
  const statusRes = await fetch(
    `http://localhost:3001/api/bridge/status/${session.aztecDepositAddress}`
  );
  return statusRes.json();
};

let status = await pollStatus();
while (status.status === "pending") {
  await new Promise((r) => setTimeout(r, 5000));
  status = await pollStatus();
}
// status.status will be "not_found" once completed (session cleaned up)
```

## EVM → Aztec Bridge

Bridge bUSDC from EVM to private USDC on Aztec.

### Flow

1. Register the bridge's `minterAddress` as a sender in your Aztec PXE (for note discovery)
2. Call `POST /api/bridge/evm-to-aztec` with your Aztec address and exact amount
3. The server returns an EVM deposit address
4. Send the **exact** bUSDC amount to the deposit address on EVM
5. The bridge detects the deposit and mints private USDC on Aztec
6. Poll `GET /api/bridge/evm-to-aztec/status/:sessionId` to track progress

### Step-by-Step (TypeScript)

```typescript
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";

// 1. Get bridge config
const healthRes = await fetch("http://localhost:3001/api/health");
const config = await healthRes.json();

// 2. Register minterAddress as sender for note discovery
// This is critical — without this, your PXE won't discover the minted notes
await userAztecWallet.registerSender(
  AztecAddress.fromString(config.minterAddress),
  "bridge-minter"
);

// 3. Create bridge session
const amount = 100n * 1_000_000n; // 100 USDC (6 decimals)
const sessionRes = await fetch("http://localhost:3001/api/bridge/evm-to-aztec", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    aztecAddress: userAztecWallet.getAddress().toString(),
    amount: amount.toString(),
  }),
});
const session = await sessionRes.json();
// session.depositAddress — send bUSDC here on EVM
// session.sessionId — use for status polling
// session.expiresAt — must complete before this timestamp

// 4. Send bUSDC on EVM to the deposit address
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

const walletClient = createWalletClient({
  account: evmAccount,
  chain: { id: config.evmChainId },
  transport: http(config.evmRpcUrl),
});

const hash = await walletClient.writeContract({
  address: config.evmTokenAddress,
  abi: ERC20_ABI,
  functionName: "transfer",
  args: [session.depositAddress, amount],
});

// 5. Poll for completion
const pollStatus = async () => {
  const statusRes = await fetch(
    `http://localhost:3001/api/bridge/evm-to-aztec/status/${session.sessionId}`
  );
  return statusRes.json();
};

let status = await pollStatus();
while (status.status === "pending" || status.status === "processing") {
  await new Promise((r) => setTimeout(r, 5000));
  status = await pollStatus();
}

if (status.status === "completed") {
  console.log("Bridge complete! Check your Aztec private balance.");
}
```

## API Reference

### `GET /api/health`

Returns server status and all configuration needed for integration.

**Response:** See [Discovery](#discovery--get-apihealth) for full field list.

---

### `POST /api/bridge/initiate`

Create an Aztec→EVM bridge session.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `evmAddress` | `string` | Yes | Destination EVM address (0x-prefixed, 40 hex chars) |
| `senderAddress` | `string` | No (strongly recommended) | Sender's Aztec address for note discovery |

**Response (200):**

```json
{
  "success": true,
  "aztecDepositAddress": "0x...",
  "expiresAt": 1700000000000,
  "message": "Send private USDC to the Aztec address within 5 minutes to bridge to EVM"
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Missing or invalid `evmAddress` |
| 503 | Server initializing or bridge disabled |

---

### `GET /api/bridge/status/:aztecAddress`

Check the status of an Aztec→EVM bridge session.

**Path Parameters:**

| Param | Description |
|-------|-------------|
| `aztecAddress` | The ephemeral Aztec deposit address from the initiate response |

**Response (200):**

```json
{
  "status": "pending",
  "evmAddress": "0x...",
  "expiresAt": 1700000000000,
  "remainingTime": 240000
}
```

**Status values:**
- `pending` — waiting for Aztec deposit
- `expired` — session timed out
- `not_found` — session doesn't exist or was completed and cleaned up

---

### `POST /api/bridge/evm-to-aztec`

Create an EVM→Aztec bridge session.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `aztecAddress` | `string` | Yes | Recipient Aztec address |
| `amount` | `string` | Yes | Amount in base units (6 decimals). Must be sent as a string (BigInt). |

**Response (200):**

```json
{
  "success": true,
  "sessionId": "evm-to-aztec-1",
  "depositAddress": "0x...",
  "expiresAt": 1700000000000,
  "message": "Send 100000000 bUSDC to 0x... on Anvil within 5 minutes"
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Missing `aztecAddress` or `amount` |
| 503 | Server initializing or reverse bridge disabled |

---

### `GET /api/bridge/evm-to-aztec/status/:sessionId`

Check the status of an EVM→Aztec bridge session.

**Path Parameters:**

| Param | Description |
|-------|-------------|
| `sessionId` | The session ID from the create response |

**Response (200):**

```json
{
  "status": "pending",
  "aztecAddress": "0x...",
  "amount": "100000000",
  "expiresAt": 1700000000000,
  "remainingTime": 240000
}
```

**Status values:**
- `pending` — waiting for EVM deposit
- `processing` — deposit detected, minting on Aztec
- `completed` — private USDC minted successfully
- `expired` — session timed out
- `not_found` — session doesn't exist

---

### `POST /api/faucet`

Mint test USDC (public) to an Aztec address. For testing only.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | `string` | Yes | Recipient Aztec address |

**Response:** `{ "success": true, "amount": "1000" }`

---

### `POST /api/faucet/private`

Mint test USDC (private) to an Aztec address. For testing only.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | `string` | Yes | Recipient Aztec address |

**Response:** `{ "success": true, "amount": "1000" }`

## Important Notes

1. **5-minute session expiration** — Bridge sessions expire after 5 minutes. If the deposit is not received in time, the session is cleaned up and you must create a new one.

2. **Exact amount matching (EVM→Aztec)** — The EVM→Aztec bridge matches deposits by exact amount. The bUSDC transfer amount must exactly match the `amount` specified when creating the session. If amounts don't match, the deposit won't be attributed to your session.

3. **6-decimal precision** — Both USDC (Aztec) and bUSDC (EVM) use 6 decimals. `1 USDC = 1_000_000` base units.

4. **Sender registration for note discovery** — Aztec's privacy model requires that recipients register expected senders to discover incoming notes:
   - **Aztec→EVM**: Pass your `senderAddress` in the initiate call so the bridge can discover your deposit.
   - **EVM→Aztec**: Register the bridge's `minterAddress` (from `/api/health`) as a sender in your PXE before creating the session.

5. **CORS enabled** — All endpoints accept cross-origin requests. No authentication is required.

6. **Sponsored fees** — The bridge uses a SponsoredFPC for Aztec transaction fees, so users don't need fee tokens.

7. **One session at a time (recommended)** — While multiple sessions can exist, the EVM→Aztec bridge matches by exact amount increase, so concurrent sessions with the same amount may conflict.
