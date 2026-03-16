import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getViemChain, EVM_RPC_URL } from "../src/config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getEvmTokenAddress(): string | undefined {
  if (process.env.EVM_TOKEN_ADDRESS) return process.env.EVM_TOKEN_ADDRESS;
  const deploymentPath = path.join(__dirname, "../evm-deployment.json");
  try {
    if (fs.existsSync(deploymentPath)) {
      const data = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
      if (data.address) return data.address;
    }
  } catch {}
  return undefined;
}

const EVM_TOKEN_ADDRESS = getEvmTokenAddress() as `0x${string}` | undefined;
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const DEMO_EVM_PRIVATE_KEY = process.env.DEMO_EVM_PRIVATE_KEY as `0x${string}`;

if (!EVM_TOKEN_ADDRESS || !EVM_PRIVATE_KEY || !DEMO_EVM_PRIVATE_KEY) {
  console.error("Missing required config. Ensure EVM_PRIVATE_KEY and DEMO_EVM_PRIVATE_KEY are in .env.localnet, and either EVM_TOKEN_ADDRESS is set or evm-deployment.json exists.");
  process.exit(1);
}

const BUSDC_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) external view returns (uint256)",
]);

async function main() {
  const chain = await getViemChain();
  const ownerAccount = privateKeyToAccount(EVM_PRIVATE_KEY);
  const demoAccount = privateKeyToAccount(DEMO_EVM_PRIVATE_KEY);

  const publicClient = createPublicClient({ chain, transport: http(EVM_RPC_URL) });
  const walletClient = createWalletClient({ account: ownerAccount, chain, transport: http(EVM_RPC_URL) });

  // 10,000 bUSDC (6 decimals)
  const amount = 10_000n * 1_000_000n;

  console.log(`Airdropping 10,000 bUSDC to ${demoAccount.address}`);
  console.log(`  Token: ${EVM_TOKEN_ADDRESS}`);
  console.log(`  RPC:   ${EVM_RPC_URL}`);

  const hash = await walletClient.writeContract({
    address: EVM_TOKEN_ADDRESS,
    abi: BUSDC_ABI,
    functionName: "mint",
    args: [demoAccount.address, amount],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Mint tx confirmed: ${receipt.transactionHash} (block ${receipt.blockNumber})`);

  const balance = await publicClient.readContract({
    address: EVM_TOKEN_ADDRESS,
    abi: BUSDC_ABI,
    functionName: "balanceOf",
    args: [demoAccount.address],
  });

  console.log(`Done! Balance: ${balance} raw units (${Number(balance) / 1e6} bUSDC)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
