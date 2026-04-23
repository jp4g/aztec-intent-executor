/**
 * Thin typed wrapper around the bridge server's HTTP API.
 *
 * Four endpoints:
 *   GET  /api/health                          — server addresses + bridge state
 *   POST /api/bridge/initiate                 — open Aztec → EVM forward session
 *   GET  /api/bridge/status/:aztecAddress     — poll forward session
 *   POST /api/bridge/evm-to-aztec             — open EVM → Aztec reverse session
 *   GET  /api/bridge/evm-to-aztec/status/:id  — poll reverse session
 *   POST /api/test/transfer-private           — test helper (private mint)
 *
 * Plus two composed flows used by the test harness:
 *   bridgeToEvm          — open forward session + fund deposit + wait for mint
 *   waitForReverseBridge — poll reverse session until completed/expired
 */

import type { Hex } from "viem";

export interface BridgeHealth {
  evmTokenAddress: Hex;
  bridgeEnabled: boolean;
  reverseBridgeEnabled: boolean;
  reverseBridgeDepositAddress: Hex | null;
  minterAddress: string | null;
}

export interface ReverseBridgeSession {
  sessionId: string;
  depositAddress: Hex;
}

export type ReverseSessionStatus = "pending" | "processing" | "completed" | "expired" | "not_found";

export class BridgeClient {
  constructor(private readonly baseUrl: string) {}

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as any;
    if (data.success === false) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
    return data as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return (await res.json()) as T;
  }

  /** Server health + bridge addresses. Throws unless both bridge directions are live. */
  async health(): Promise<BridgeHealth> {
    const data = await this.getJson<any>("/api/health");
    if (data.status !== "ok") throw new Error("Server not ready");
    if (!data.bridgeEnabled) throw new Error("Forward bridge not enabled on server");
    if (!data.reverseBridgeEnabled) throw new Error("Reverse bridge not enabled on server");
    return {
      evmTokenAddress: data.evmTokenAddress,
      bridgeEnabled: data.bridgeEnabled,
      reverseBridgeEnabled: data.reverseBridgeEnabled,
      reverseBridgeDepositAddress: data.reverseBridgeDepositAddress,
      minterAddress: data.minterAddress,
    };
  }

  /** Open a forward bridge session targeting `evmAddress`. */
  async initiateForward(evmAddress: Hex, senderAddress?: string): Promise<{ aztecDepositAddress: string; expiresAt: number }> {
    return this.postJson("/api/bridge/initiate", { evmAddress, senderAddress });
  }

  /** Forward session status lookup by Aztec deposit address. */
  async forwardStatus(aztecDepositAddress: string): Promise<{ status: string }> {
    return this.getJson(`/api/bridge/status/${aztecDepositAddress}`);
  }

  /** Test helper — mint private USDC to an Aztec address (used to simulate the user's deposit). */
  async testTransferPrivate(to: string, amount: bigint): Promise<void> {
    await this.postJson("/api/test/transfer-private", { to, amount: amount.toString() });
  }

  /** Open a reverse bridge session (amount-matched; the bridge mints private USDC to `aztecAddress` once its wallet sees an incoming deposit of exactly `amount`). */
  async initiateReverse(aztecAddress: string, amount: bigint): Promise<ReverseBridgeSession> {
    const data = await this.postJson<{ sessionId: string; depositAddress: Hex }>(
      "/api/bridge/evm-to-aztec",
      { aztecAddress, amount: amount.toString() },
    );
    return { sessionId: data.sessionId, depositAddress: data.depositAddress };
  }

  /** Reverse session status lookup. */
  async reverseStatus(sessionId: string): Promise<{ status: ReverseSessionStatus }> {
    return this.getJson(`/api/bridge/evm-to-aztec/status/${sessionId}`);
  }

  // ---- Composed flows used by the integration test -----------------------

  /**
   * Full Aztec → EVM bridge: open session, fund deposit, wait for EVM mint.
   * Resolves once the forward session has been cleared from the server
   * (i.e. the mint has landed on EVM). Throws on timeout.
   */
  async bridgeToEvm(params: {
    evmAddress: Hex;
    amountMicro: bigint;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
  }): Promise<void> {
    const log = params.onProgress ?? (() => {});
    const timeoutMs = params.timeoutMs ?? 90_000;

    log(`Initiating forward session to ${params.evmAddress}...`);
    const { aztecDepositAddress } = await this.initiateForward(params.evmAddress);
    log(`Deposit address: ${aztecDepositAddress}`);

    log(`Funding deposit with ${params.amountMicro} (private mint)...`);
    await this.testTransferPrivate(aztecDepositAddress, params.amountMicro);

    log("Waiting for bridge to mint bUSDC on EVM...");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { status } = await this.forwardStatus(aztecDepositAddress);
      if (status === "not_found") {
        log("Forward session complete.");
        return;
      }
      await sleep(3_000);
    }
    throw new Error(`Forward bridge to ${params.evmAddress} timed out`);
  }

  /**
   * Poll a reverse session until it completes. Logs status transitions if a
   * progress callback is provided. Throws on expired / not_found / timeout.
   */
  async waitForReverseBridge(sessionId: string, params?: {
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
  }): Promise<void> {
    const log = params?.onProgress ?? (() => {});
    const timeoutMs = params?.timeoutMs ?? 90_000;
    const deadline = Date.now() + timeoutMs;
    let last: ReverseSessionStatus | "unknown" = "unknown";
    while (Date.now() < deadline) {
      const { status } = await this.reverseStatus(sessionId);
      if (status !== last) {
        log(`reverse session ${sessionId}: ${status}`);
        last = status;
      }
      if (status === "completed") return;
      if (status === "expired" || status === "not_found") {
        throw new Error(`reverse session ${sessionId} ended as ${status}`);
      }
      await sleep(2_000);
    }
    throw new Error(`reverse session ${sessionId} timed out in "${last}"`);
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
