import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { TokenContract } from "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js";
import type { PXE } from "@aztec/pxe/server";

interface BridgeSession {
  evmAddress: string;
  aztecAddress: AztecAddress;
  senderAddress?: AztecAddress;
  secret: Fr;
  salt: Fr;
  createdAt: number;
  expiresAt: number;
}

const BRIDGE_SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL = 5000; // 5 seconds

const BRIDGED_USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) external view returns (uint256)",
]);

interface ReverseBridgeSession {
  id: string;
  aztecAddress: AztecAddress;
  amount: bigint;
  status: "pending" | "processing" | "completed" | "expired";
  createdAt: number;
  expiresAt: number;
}

export class EvmToAztecBridge {
  private sessions: Map<string, ReverseBridgeSession> = new Map();
  private wallet: EmbeddedWallet;
  private token: TokenContract;
  private minterAddress: AztecAddress;
  private evmTokenAddress: `0x${string}`;
  private evmRpcUrl: string;
  private bridgeWalletAddress: `0x${string}`;
  private lastKnownBalance: bigint = 0n;
  private pollInterval: NodeJS.Timeout | null = null;
  private sessionCounter = 0;

  constructor(
    wallet: EmbeddedWallet,
    token: TokenContract,
    minterAddress: AztecAddress,
    evmTokenAddress: string,
    evmPrivateKey: string,
    evmRpcUrl: string = "http://localhost:8545"
  ) {
    this.wallet = wallet;
    this.token = token;
    this.minterAddress = minterAddress;
    this.evmTokenAddress = evmTokenAddress as `0x${string}`;
    this.evmRpcUrl = evmRpcUrl;

    const account = privateKeyToAccount(evmPrivateKey as `0x${string}`);
    this.bridgeWalletAddress = account.address;
  }

  async start() {
    console.log("[ReverseBridge] Starting EVM -> Aztec bridge service...");
    console.log(`[ReverseBridge] Bridge wallet (EVM): ${this.bridgeWalletAddress}`);

    // Initialize lastKnownBalance
    this.lastKnownBalance = await this.getEvmBalance();
    console.log(`[ReverseBridge] Initial bridge wallet bUSDC balance: ${this.lastKnownBalance}`);

    this.pollInterval = setInterval(() => this.pollEvmBalance(), POLL_INTERVAL);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  createSession(aztecAddress: string, amount: bigint): {
    sessionId: string;
    depositAddress: string;
    expiresAt: number;
  } {
    const now = Date.now();
    const id = `evm-to-aztec-${++this.sessionCounter}`;

    const session: ReverseBridgeSession = {
      id,
      aztecAddress: AztecAddress.fromString(aztecAddress),
      amount,
      status: "pending",
      createdAt: now,
      expiresAt: now + BRIDGE_SESSION_TIMEOUT,
    };

    this.sessions.set(id, session);

    console.log(`[ReverseBridge] Created session ${id}`);
    console.log(`[ReverseBridge]   Aztec recipient: ${aztecAddress}`);
    console.log(`[ReverseBridge]   Amount: ${amount}`);
    console.log(`[ReverseBridge]   Deposit to: ${this.bridgeWalletAddress}`);
    console.log(`[ReverseBridge]   Expires at: ${new Date(session.expiresAt).toISOString()}`);

    return {
      sessionId: id,
      depositAddress: this.bridgeWalletAddress,
      expiresAt: session.expiresAt,
    };
  }

  private async getEvmBalance(): Promise<bigint> {
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(this.evmRpcUrl),
    });

    try {
      const balance = await publicClient.readContract({
        address: this.evmTokenAddress,
        abi: BRIDGED_USDC_ABI,
        functionName: "balanceOf",
        args: [this.bridgeWalletAddress],
      });
      return balance as bigint;
    } catch (error) {
      console.error("[ReverseBridge] Error reading EVM balance:", error);
      return this.lastKnownBalance;
    }
  }

  private async pollEvmBalance() {
    const now = Date.now();

    // Clean up expired sessions
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === "pending" && now > session.expiresAt) {
        console.log(`[ReverseBridge] Session ${id} expired`);
        session.status = "expired";
        this.sessions.delete(id);
      }
    }

    // Check for pending sessions
    const pendingSessions = [...this.sessions.values()].filter(s => s.status === "pending");
    if (pendingSessions.length === 0) return;

    try {
      const currentBalance = await this.getEvmBalance();
      const increase = currentBalance - this.lastKnownBalance;

      if (increase > 0n) {
        console.log(`[ReverseBridge] Detected balance increase of ${increase} bUSDC`);

        // Match against pending sessions by amount
        const matched = pendingSessions.find(s => s.amount === increase);
        if (matched) {
          console.log(`[ReverseBridge] Matched session ${matched.id} (amount: ${matched.amount})`);
          matched.status = "processing";
          this.lastKnownBalance = currentBalance;

          try {
            const { mintTokensPrivate } = await import("./utils.js");
            console.log(`[ReverseBridge] Minting ${matched.amount} USDC privately to ${matched.aztecAddress.toString()}...`);
            await mintTokensPrivate(this.token, this.minterAddress, matched.aztecAddress, matched.amount);

            matched.status = "completed";
            console.log(`[ReverseBridge] Session ${matched.id} completed!`);
          } catch (error) {
            console.error(`[ReverseBridge] Failed to mint on Aztec for session ${matched.id}:`, error);
            matched.status = "pending"; // Allow retry
          }
        } else {
          console.log(`[ReverseBridge] No matching session for amount ${increase}`);
          this.lastKnownBalance = currentBalance;
        }
      }
    } catch (error) {
      console.error("[ReverseBridge] Error polling EVM balance:", error);
    }
  }

  getSession(sessionId: string): ReverseBridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessionsCount(): number {
    return [...this.sessions.values()].filter(s => s.status === "pending" || s.status === "processing").length;
  }

  getDepositAddress(): string {
    return this.bridgeWalletAddress;
  }
}

export class AztecToEvmBridge {
  private sessions: Map<string, BridgeSession> = new Map();
  private processingJobs: Set<string> = new Set();
  private wallet: EmbeddedWallet;
  private pxe: PXE;
  private token: TokenContract;
  private evmTokenAddress: `0x${string}`;
  private evmPrivateKey: `0x${string}`;
  private evmRpcUrl: string;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    wallet: EmbeddedWallet,
    token: TokenContract,
    evmTokenAddress: string,
    evmPrivateKey: string,
    evmRpcUrl: string = "http://localhost:8545"
  ) {
    this.wallet = wallet;
    this.pxe = (wallet as unknown as { pxe: PXE }).pxe;
    this.token = token;
    this.evmTokenAddress = evmTokenAddress as `0x${string}`;
    this.evmPrivateKey = evmPrivateKey as `0x${string}`;
    this.evmRpcUrl = evmRpcUrl;
  }

  async start() {
    console.log("[Bridge] Starting bridge service...");
    await this.cleanupLeftoverSenders();
    this.pollInterval = setInterval(() => this.pollSessions(), POLL_INTERVAL);
  }

  private async cleanupLeftoverSenders() {
    try {
      const senders = await this.pxe.getSenders();
      if (senders.length > 0) {
        console.log(`[Bridge] Found ${senders.length} leftover sender(s), cleaning up...`);
        for (const sender of senders) {
          await this.pxe.removeSender(sender);
          console.log(`[Bridge] Removed leftover sender ${sender.toString()}`);
        }
      } else {
        console.log(`[Bridge] No leftover senders to clean up`);
      }
    } catch (error) {
      console.warn(`[Bridge] Failed to clean up leftover senders:`, error);
    }
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async createSession(evmAddress: string, senderAddress?: string): Promise<{
    aztecAddress: string;
    expiresAt: number;
  }> {
    const secret = Fr.random();
    const salt = Fr.random();

    const accountManager = await this.createEphemeralAccount(secret, salt);
    const aztecAddress = accountManager.address;

    let senderAddr: AztecAddress | undefined;
    if (senderAddress) {
      senderAddr = AztecAddress.fromString(senderAddress);
      console.log(`[Bridge] Registering sender ${senderAddress} for note discovery...`);
      await this.wallet.registerSender(senderAddr, 'bridge-sender');
    } else {
      console.warn(`[Bridge] WARNING: No sender address provided - note discovery may fail!`);
    }

    const now = Date.now();
    const session: BridgeSession = {
      evmAddress,
      aztecAddress,
      senderAddress: senderAddr,
      secret,
      salt,
      createdAt: now,
      expiresAt: now + BRIDGE_SESSION_TIMEOUT,
    };

    this.sessions.set(aztecAddress.toString(), session);

    console.log(`[Bridge] Created session for EVM ${evmAddress}`);
    console.log(`[Bridge] Aztec deposit address: ${aztecAddress.toString()}`);
    console.log(`[Bridge] Expires at: ${new Date(session.expiresAt).toISOString()}`);

    return {
      aztecAddress: aztecAddress.toString(),
      expiresAt: session.expiresAt,
    };
  }

  private async createEphemeralAccount(secret: Fr, salt: Fr) {
    const { GrumpkinScalar } = await import("@aztec/foundation/curves/grumpkin");
    const { SchnorrAccountContract } = await import("@aztec/accounts/schnorr");
    const { AccountManager } = await import("@aztec/aztec.js/wallet");

    const signingKey = GrumpkinScalar.fromBuffer(secret.toBuffer());
    const accountManager = await AccountManager.create(
      this.wallet,
      secret,
      new SchnorrAccountContract(signingKey),
      salt
    );

    const instance = await accountManager.getInstance();
    const artifact = await accountManager.getAccountContract().getContractArtifact();
    await this.wallet.registerContract(instance, artifact, accountManager.getSecretKey());

    return accountManager;
  }

  private async pollSessions() {
    const now = Date.now();

    for (const [aztecAddr, session] of this.sessions.entries()) {
      if (this.processingJobs.has(aztecAddr)) {
        continue;
      }

      if (now > session.expiresAt) {
        console.log(`[Bridge] Session expired for ${session.evmAddress}`);
        if (session.senderAddress) {
          await this.pxe.removeSender(session.senderAddress);
          console.log(`[Bridge] Cleaned up sender ${session.senderAddress.toString()}`);
        }
        this.sessions.delete(aztecAddr);
        continue;
      }

      try {
        console.log(`[Bridge] Checking private balance for ${aztecAddr.slice(0, 10)}...`);
        const balance = await this.checkPrivateBalance(session.aztecAddress);
        console.log(`[Bridge] Private balance: ${balance}`);

        if (balance > 0n) {
          console.log(`[Bridge] Detected private deposit of ${balance} to ${aztecAddr}`);
          this.processingJobs.add(aztecAddr);

          console.log(`[Bridge] Minting ${balance} to EVM address ${session.evmAddress}`);

          try {
            await this.mintOnEvm(session.evmAddress, balance);
          } catch (mintError) {
            console.error(`[Bridge] EVM MINT FAILED:`, mintError);
            this.processingJobs.delete(aztecAddr);
            continue;
          }

          if (session.senderAddress) {
            await this.pxe.removeSender(session.senderAddress);
            console.log(`[Bridge] Cleaned up sender ${session.senderAddress.toString()}`);
          }

          this.processingJobs.delete(aztecAddr);
          this.sessions.delete(aztecAddr);
          console.log(`[Bridge] Bridge completed for ${session.evmAddress}`);
        }
      } catch (error) {
        console.error(`[Bridge] Error checking balance for ${aztecAddr}:`, error);
        this.processingJobs.delete(aztecAddr);
      }
    }
  }

  private async checkPrivateBalance(address: AztecAddress): Promise<bigint> {
    try {
      const balance = await this.token.methods
        .balance_of_private(address)
        .simulate({ from: address });
      return balance;
    } catch (error) {
      console.error(`[Bridge] Error checking private balance for ${address}:`, error);
      return 0n;
    }
  }

  private async mintOnEvm(to: string, amount: bigint) {
    console.log(`[Bridge] mintOnEvm called - to: ${to}, amount: ${amount}`);

    const account = privateKeyToAccount(this.evmPrivateKey);
    console.log(`[Bridge] Minter account: ${account.address}`);

    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(this.evmRpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain: foundry,
      transport: http(this.evmRpcUrl),
    });

    console.log(`[Bridge] Sending mint transaction...`);

    const hash = await walletClient.writeContract({
      address: this.evmTokenAddress,
      abi: BRIDGED_USDC_ABI,
      functionName: "mint",
      args: [to as `0x${string}`, amount],
    });

    console.log(`[Bridge] EVM mint tx submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[Bridge] EVM mint confirmed - status: ${receipt.status}, block: ${receipt.blockNumber}`);
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getSession(aztecAddress: string): BridgeSession | undefined {
    return this.sessions.get(aztecAddress);
  }
}
