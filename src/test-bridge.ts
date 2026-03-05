/**
 * Bridge Integration Test Script
 *
 * Tests the complete Aztec -> EVM bridge flow:
 * 1. Check server health + bridge enabled
 * 2. Check initial EVM balance
 * 3. Initiate bridge session
 * 4. Transfer private tokens to deposit address
 * 5. Wait for bridge to detect and mint on EVM
 * 6. Verify EVM balance increased
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import "dotenv/config";

const SERVER_URL = "http://localhost:3001";
const EVM_RPC_URL = "http://localhost:8545";
const BRIDGE_AMOUNT = 100; // 100 USDC

// Anvil default account #0
const TEST_EVM_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Anvil default private key for account #0
const TEST_EVM_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  if (data !== undefined) {
    console.log(`[${timestamp}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60) + "\n");
}

async function getEvmBalance(tokenAddress: string, account: string): Promise<bigint> {
  const client = createPublicClient({
    chain: foundry,
    transport: http(EVM_RPC_URL),
  });

  try {
    const balance = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account as `0x${string}`],
    });
    return balance as bigint;
  } catch (error) {
    return 0n;
  }
}

async function checkServerHealth(): Promise<{
  tokenAddress: string;
  evmTokenAddress: string;
  bridgeEnabled: boolean;
} | null> {
  try {
    const response = await fetch(`${SERVER_URL}/api/health`);
    const data = await response.json();

    if (data.status !== "ok") {
      return null;
    }

    return {
      tokenAddress: data.tokenAddress,
      evmTokenAddress: data.evmTokenAddress,
      bridgeEnabled: data.bridgeEnabled,
    };
  } catch (error) {
    return null;
  }
}

async function transferPrivateToAddress(to: string, amount: number): Promise<boolean> {
  try {
    log(`Transferring ${amount} USDC privately to ${to}...`);
    const response = await fetch(`${SERVER_URL}/api/test/transfer-private`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, amount: amount * 1000000 }), // Convert to 6 decimals
    });

    const data = await response.json();
    if (data.success) {
      log(`✓ Transferred ${amount} USDC privately`);
      return true;
    } else {
      log(`✗ Transfer failed: ${data.error}`);
      return false;
    }
  } catch (error) {
    log(`✗ Transfer request failed:`, error);
    return false;
  }
}

async function initiateBridge(evmAddress: string, senderAddress?: string): Promise<{
  aztecDepositAddress: string;
  expiresAt: number;
} | null> {
  try {
    log(`Initiating bridge for EVM address ${evmAddress}...`);
    const response = await fetch(`${SERVER_URL}/api/bridge/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evmAddress, senderAddress }),
    });

    const data = await response.json();
    if (data.success) {
      log(`✓ Bridge session created`);
      log(`  Aztec deposit address: ${data.aztecDepositAddress}`);
      log(`  Expires at: ${new Date(data.expiresAt).toISOString()}`);
      return {
        aztecDepositAddress: data.aztecDepositAddress,
        expiresAt: data.expiresAt,
      };
    } else {
      log(`✗ Bridge initiation failed: ${data.error}`);
      return null;
    }
  } catch (error) {
    log(`✗ Bridge request failed:`, error);
    return null;
  }
}

async function checkBridgeStatus(aztecAddress: string): Promise<string> {
  try {
    const response = await fetch(`${SERVER_URL}/api/bridge/status/${aztecAddress}`);
    const data = await response.json();
    return data.status;
  } catch (error) {
    return "error";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transferBusdcOnEvm(
  tokenAddress: string,
  to: string,
  amount: bigint
): Promise<boolean> {
  try {
    const account = privateKeyToAccount(TEST_EVM_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(EVM_RPC_URL),
    });
    const walletClient = createWalletClient({
      account,
      chain: foundry,
      transport: http(EVM_RPC_URL),
    });

    const hash = await walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, amount],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success";
  } catch (error) {
    log(`✗ EVM transfer failed:`, error);
    return false;
  }
}

async function initiateReverseBridge(aztecAddress: string, amount: bigint): Promise<{
  sessionId: string;
  depositAddress: string;
  expiresAt: number;
} | null> {
  try {
    log(`Initiating reverse bridge for Aztec address ${aztecAddress}...`);
    const response = await fetch(`${SERVER_URL}/api/bridge/evm-to-aztec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aztecAddress, amount: amount.toString() }),
    });

    const data = await response.json();
    if (data.success) {
      log(`✓ Reverse bridge session created`);
      log(`  Session ID: ${data.sessionId}`);
      log(`  Deposit address: ${data.depositAddress}`);
      return {
        sessionId: data.sessionId,
        depositAddress: data.depositAddress,
        expiresAt: data.expiresAt,
      };
    } else {
      log(`✗ Reverse bridge initiation failed: ${data.error}`);
      return null;
    }
  } catch (error) {
    log(`✗ Reverse bridge request failed:`, error);
    return null;
  }
}

async function checkReverseBridgeStatus(sessionId: string): Promise<string> {
  try {
    const response = await fetch(`${SERVER_URL}/api/bridge/evm-to-aztec/status/${sessionId}`);
    const data = await response.json();
    return data.status;
  } catch (error) {
    return "error";
  }
}

async function testForwardBridge(health: { tokenAddress: string; evmTokenAddress: string }): Promise<boolean> {
  logSection("FORWARD BRIDGE: AZTEC -> EVM");

  // Check initial EVM balance
  logSection("Step 1: Checking Initial EVM Balance");

  const initialEvmBalance = await getEvmBalance(health.evmTokenAddress, TEST_EVM_ADDRESS);
  log(`EVM Address: ${TEST_EVM_ADDRESS}`);
  log(`Initial bUSDC Balance: ${formatUnits(initialEvmBalance, 6)} bUSDC`);

  // Initiate bridge session
  logSection("Step 2: Initiating Bridge Session");

  const bridgeSession = await initiateBridge(TEST_EVM_ADDRESS);

  if (!bridgeSession) {
    log("✗ Failed to initiate bridge session");
    return false;
  }

  // Transfer private USDC to bridge address
  logSection("Step 3: Sending Private Transfer to Bridge");

  log(`Sending ${BRIDGE_AMOUNT} USDC privately to bridge deposit address...`);

  const transferSuccess = await transferPrivateToAddress(
    bridgeSession.aztecDepositAddress,
    BRIDGE_AMOUNT
  );

  if (!transferSuccess) {
    log("✗ Failed to transfer to bridge address");
    return false;
  }

  // Wait for bridge to process
  logSection("Step 4: Waiting for Bridge to Process");

  log("Bridge polls every 5 seconds for balance changes...");
  log("Waiting for bridge to detect deposit and mint on EVM...\n");

  const maxWaitTime = 60000;
  const pollInterval = 3000;
  const startTime = Date.now();

  let bridgeCompleted = false;

  while (Date.now() - startTime < maxWaitTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s elapsed`);

    const status = await checkBridgeStatus(bridgeSession.aztecDepositAddress);

    if (status === "not_found") {
      console.log("\n");
      log("✓ Bridge session completed (session removed)");
      bridgeCompleted = true;
      break;
    }

    const currentEvmBalance = await getEvmBalance(health.evmTokenAddress, TEST_EVM_ADDRESS);
    if (currentEvmBalance > initialEvmBalance) {
      console.log("\n");
      log("✓ EVM balance increased - bridge completed!");
      bridgeCompleted = true;
      break;
    }

    await sleep(pollInterval);
  }

  if (!bridgeCompleted) {
    console.log("\n");
    log("✗ Bridge did not complete within timeout");
    return false;
  }

  // Verify final balances
  logSection("Step 5: Final Balance Check");

  const finalEvmBalance = await getEvmBalance(health.evmTokenAddress, TEST_EVM_ADDRESS);

  log(`Initial bUSDC Balance: ${formatUnits(initialEvmBalance, 6)} bUSDC`);
  log(`Final bUSDC Balance: ${formatUnits(finalEvmBalance, 6)} bUSDC`);
  log(`Change: +${formatUnits(finalEvmBalance - initialEvmBalance, 6)} bUSDC`);

  return finalEvmBalance > initialEvmBalance;
}

async function testReverseBridge(health: { tokenAddress: string; evmTokenAddress: string }): Promise<boolean> {
  logSection("REVERSE BRIDGE: EVM -> AZTEC");

  const reverseAmount = BigInt(BRIDGE_AMOUNT) * 1000000n; // 6 decimals

  // Check we have enough bUSDC from the forward bridge
  logSection("Step 1: Checking bUSDC Balance for Reverse Bridge");

  const evmBalance = await getEvmBalance(health.evmTokenAddress, TEST_EVM_ADDRESS);
  log(`Current bUSDC balance: ${formatUnits(evmBalance, 6)} bUSDC`);

  if (evmBalance < reverseAmount) {
    log(`✗ Not enough bUSDC for reverse bridge (need ${formatUnits(reverseAmount, 6)})`);
    return false;
  }

  // Get the minter address from health to use as Aztec recipient
  const healthResp = await fetch(`${SERVER_URL}/api/health`);
  const healthData = await healthResp.json();
  const aztecRecipient = healthData.minterAddress;
  log(`Aztec recipient (minter): ${aztecRecipient}`);

  // Initiate reverse bridge session
  logSection("Step 2: Initiating Reverse Bridge Session");

  const reverseSession = await initiateReverseBridge(aztecRecipient, reverseAmount);

  if (!reverseSession) {
    log("✗ Failed to initiate reverse bridge session");
    return false;
  }

  // Transfer bUSDC to bridge deposit address
  logSection("Step 3: Sending bUSDC to Bridge Wallet on EVM");

  log(`Transferring ${formatUnits(reverseAmount, 6)} bUSDC to ${reverseSession.depositAddress}...`);

  const transferSuccess = await transferBusdcOnEvm(
    health.evmTokenAddress,
    reverseSession.depositAddress,
    reverseAmount
  );

  if (!transferSuccess) {
    log("✗ Failed to transfer bUSDC on EVM");
    return false;
  }

  log("✓ bUSDC transferred to bridge wallet");

  // Wait for reverse bridge to process
  logSection("Step 4: Waiting for Reverse Bridge to Process");

  log("Reverse bridge polls every 5 seconds for balance changes...\n");

  const maxWaitTime = 90000; // 90 seconds for Aztec minting
  const pollInterval = 3000;
  const startTime = Date.now();

  let bridgeCompleted = false;

  while (Date.now() - startTime < maxWaitTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s elapsed`);

    const status = await checkReverseBridgeStatus(reverseSession.sessionId);

    if (status === "completed") {
      console.log("\n");
      log("✓ Reverse bridge session completed!");
      bridgeCompleted = true;
      break;
    }

    if (status === "not_found" || status === "expired") {
      console.log("\n");
      log(`✗ Reverse bridge session ${status}`);
      return false;
    }

    await sleep(pollInterval);
  }

  if (!bridgeCompleted) {
    console.log("\n");
    log("✗ Reverse bridge did not complete within timeout");
    return false;
  }

  logSection("Step 5: Reverse Bridge Result");
  log("✓ Reverse bridge completed - USDC privately minted on Aztec");

  return true;
}

async function main() {
  logSection("BRIDGE INTEGRATION TESTS");

  // Check server health
  logSection("Checking Server Status");

  log("Connecting to server...");
  const health = await checkServerHealth();

  if (!health) {
    log("✗ Server is not ready. Make sure to run: yarn server");
    process.exit(1);
  }

  log(`✓ Server is ready`);
  log(`  Aztec Token: ${health.tokenAddress}`);
  log(`  EVM Token: ${health.evmTokenAddress || "Not configured"}`);
  log(`  Bridge Enabled: ${health.bridgeEnabled}`);

  if (!health.bridgeEnabled || !health.evmTokenAddress) {
    log("\n✗ Bridge is not enabled!");
    log("  Start the server with EVM_TOKEN_ADDRESS set");
    process.exit(1);
  }

  // Test 1: Forward bridge (Aztec -> EVM)
  const forwardResult = await testForwardBridge(health);

  logSection("FORWARD BRIDGE RESULT");
  if (forwardResult) {
    log("✓ FORWARD BRIDGE TEST PASSED!");
  } else {
    log("✗ FORWARD BRIDGE TEST FAILED");
    process.exit(1);
  }

  // Test 2: Reverse bridge (EVM -> Aztec)
  const reverseResult = await testReverseBridge(health);

  logSection("REVERSE BRIDGE RESULT");
  if (reverseResult) {
    log("✓ REVERSE BRIDGE TEST PASSED!");
  } else {
    log("✗ REVERSE BRIDGE TEST FAILED");
    process.exit(1);
  }

  // Final summary
  logSection("ALL TESTS PASSED");
  log("✓ Forward bridge (Aztec -> EVM): PASSED");
  log("✓ Reverse bridge (EVM -> Aztec): PASSED");
  process.exit(0);
}

main().catch((error) => {
  console.error("Test script error:", error);
  process.exit(1);
});
