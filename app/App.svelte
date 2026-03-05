<script lang="ts">
  import {
    initializeAztec,
    createAccount,
    getBalance,
    transferPrivate,
    registerSender,
    registerTokenContract,
    syncPXE,
    generateRandomSecret,
  } from "./aztec-client";

  interface AccountCredentials {
    secret: string;
    salt: string;
    address: string;
  }

  const DEMO_EVM_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const STORAGE_KEY = 'aztecBridgeAccount';

  // Initialization state
  let serverReady = $state(false);
  let aztecReady = $state(false);
  let initStatus = $state("Connecting to server...");

  // Account state
  let userAccount = $state<AccountCredentials | null>(null);
  let aztecBalance = $state("0");
  let evmBalance = $state("0");

  // Config from server
  let tokenAddress = $state<string | null>(null);
  let minterAddress = $state<string | null>(null);
  let evmTokenAddress = $state<string | null>(null);
  let fpcAddress = $state<string | null>(null);
  let nodeUrl = $state<string | null>(null);

  // Bridge state
  let bridgeToEvmAmount = $state<number | null>(null);
  let bridgeToAztecAmount = $state<number | null>(null);
  let bridgeToEvmStatus = $state("");
  let bridgeToAztecStatus = $state("");
  let isBridgingToEvm = $state(false);
  let isBridgingToAztec = $state(false);
  let isFauceting = $state(false);
  let isRefreshing = $state(false);

  // Activity log
  let logEntries = $state<Array<{ time: string; text: string; type: string }>>([]);

  function addLog(text: string, type: string = "") {
    const time = new Date().toLocaleTimeString();
    logEntries = [...logEntries, { time, text, type }];
  }

  function truncateAddress(addr: string): string {
    if (addr.length <= 12) return addr;
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  // Initialize on mount
  $effect(() => {
    initialize();
  });

  async function initialize() {
    try {
      // Step 1: Poll server health
      initStatus = "Checking server...";
      const health = await checkServerHealth();
      if (!health) return;

      tokenAddress = health.tokenAddress;
      minterAddress = health.minterAddress;
      evmTokenAddress = health.evmTokenAddress;
      fpcAddress = health.sponsoredFpcAddress;
      nodeUrl = health.nodeUrl;
      serverReady = true;
      addLog("Server connected", "success");

      // Step 2: Initialize Aztec client in browser
      initStatus = "Initializing Aztec client (this may take a moment)...";
      await initializeAztec(nodeUrl!, fpcAddress!);
      aztecReady = true;
      addLog("Aztec client initialized", "success");

      // Step 3: Load or create account
      initStatus = "Setting up account...";
      await initializeAccount();

      // Step 4: Register token contract
      if (tokenAddress) {
        initStatus = "Registering token contract...";
        await registerTokenContract(tokenAddress);
        addLog("Token contract registered", "info");
      }

      // Step 5: Register minter as sender for note discovery
      if (minterAddress) {
        await registerSender(minterAddress);
        addLog("Minter registered for note discovery", "info");
      }

      // Step 6: Refresh balances
      initStatus = "Loading balances...";
      await refreshBalances();

      initStatus = "Ready!";
      addLog("Initialization complete", "success");
    } catch (error) {
      console.error("Initialization error:", error);
      initStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
      addLog(`Init error: ${error instanceof Error ? error.message : String(error)}`, "error");
      setTimeout(initialize, 5000);
    }
  }

  async function checkServerHealth(): Promise<any | null> {
    try {
      const response = await fetch("/api/health");
      const data = await response.json();

      if (data.status === "ok" && data.tokenAddress) {
        return data;
      } else if (data.status === "initializing") {
        initStatus = "Server is deploying contracts...";
        setTimeout(initialize, 3000);
        return null;
      }
      return null;
    } catch {
      initStatus = "Waiting for server...";
      setTimeout(initialize, 3000);
      return null;
    }
  }

  async function initializeAccount() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Re-register account with browser's Aztec client
      const account = await createAccount(parsed.secret, parsed.salt);
      userAccount = {
        secret: parsed.secret,
        salt: parsed.salt,
        address: account.address,
      };
      addLog(`Account loaded: ${truncateAddress(account.address)}`, "info");
    } else {
      await createNewAccount();
    }
  }

  async function createNewAccount() {
    const secret = generateRandomSecret();
    const salt = generateRandomSecret();

    addLog("Creating new account...", "info");
    const account = await createAccount(secret, salt, true, fpcAddress!);

    userAccount = { secret, salt, address: account.address };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userAccount));
    addLog(`Account created: ${truncateAddress(account.address)}`, "success");
  }

  async function refreshBalances() {
    isRefreshing = true;
    try {
      // Aztec balance (client-side)
      if (userAccount && tokenAddress) {
        const rawBalance = await getBalance(tokenAddress, userAccount.address);
        aztecBalance = (rawBalance / 1000000n).toString();
      }

      // EVM balance (server-side)
      try {
        const res = await fetch("/api/demo/evm-balance");
        const data = await res.json();
        evmBalance = data.formatted || "0";
      } catch {
        // EVM balance endpoint might not exist yet
      }
    } catch (error) {
      console.error("Balance refresh error:", error);
    } finally {
      isRefreshing = false;
    }
  }

  async function faucet() {
    if (!userAccount || isFauceting) return;
    isFauceting = true;
    addLog("Requesting test USDC from faucet...", "info");

    try {
      const response = await fetch("/api/faucet/private", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: userAccount.address }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Faucet failed");
      }

      addLog("Faucet mint complete, syncing...", "info");

      // Register minter and sync to discover new notes
      if (minterAddress) {
        await registerSender(minterAddress);
      }
      await syncPXE();
      await refreshBalances();
      addLog(`Received 1000 USDC`, "success");
    } catch (error) {
      addLog(`Faucet error: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      isFauceting = false;
    }
  }

  async function bridgeToEvm() {
    if (!bridgeToEvmAmount || bridgeToEvmAmount <= 0 || !userAccount || !tokenAddress || !fpcAddress) return;
    isBridgingToEvm = true;
    bridgeToEvmStatus = "";
    const amount = BigInt(Math.floor(bridgeToEvmAmount * 1e6));

    try {
      // Step 1: Initiate bridge session on server
      bridgeToEvmStatus = "Creating bridge session...";
      addLog(`Bridging ${bridgeToEvmAmount} USDC to EVM...`, "info");

      const initRes = await fetch("/api/bridge/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          evmAddress: DEMO_EVM_ADDRESS,
          senderAddress: userAccount.address,
        }),
      });
      const initData = await initRes.json();

      if (!initRes.ok) throw new Error(initData.error);

      const depositAddress = initData.aztecDepositAddress;
      addLog(`Deposit address: ${truncateAddress(depositAddress)}`, "info");

      // Step 2: Client-side private transfer to deposit address
      bridgeToEvmStatus = "Sending private transfer (this takes ~30s)...";
      await transferPrivate(
        tokenAddress!,
        userAccount.secret,
        userAccount.salt,
        depositAddress,
        amount,
        fpcAddress!
      );
      addLog("Private transfer sent, waiting for bridge...", "info");

      // Step 3: Poll bridge status
      bridgeToEvmStatus = "Waiting for bridge to process...";
      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 5000));
        attempts++;

        const statusRes = await fetch(`/api/bridge/status/${depositAddress}`);
        const statusData = await statusRes.json();

        if (statusData.status === "not_found") {
          // Session cleaned up = bridge completed
          bridgeToEvmStatus = "Bridge complete!";
          addLog(`Bridged ${bridgeToEvmAmount} USDC to EVM`, "success");
          await refreshBalances();
          break;
        } else if (statusData.status === "expired") {
          throw new Error("Bridge session expired");
        }

        bridgeToEvmStatus = `Waiting for bridge... (${attempts * 5}s)`;
      }

      if (attempts >= maxAttempts) {
        throw new Error("Bridge timed out");
      }
    } catch (error) {
      bridgeToEvmStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
      addLog(`Bridge to EVM error: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      isBridgingToEvm = false;
    }
  }

  async function bridgeToAztec() {
    if (!bridgeToAztecAmount || bridgeToAztecAmount <= 0 || !userAccount) return;
    isBridgingToAztec = true;
    bridgeToAztecStatus = "";
    const amount = BigInt(Math.floor(bridgeToAztecAmount * 1e6));

    try {
      // Step 1: Create reverse bridge session
      bridgeToAztecStatus = "Creating bridge session...";
      addLog(`Bridging ${bridgeToAztecAmount} bUSDC to Aztec...`, "info");

      const initRes = await fetch("/api/bridge/evm-to-aztec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aztecAddress: userAccount.address,
          amount: amount.toString(),
        }),
      });
      const initData = await initRes.json();

      if (!initRes.ok) throw new Error(initData.error);

      const sessionId = initData.sessionId;
      addLog(`Session created: ${sessionId}`, "info");

      // Step 2: Server transfers bUSDC from demo account to bridge
      bridgeToAztecStatus = "Transferring bUSDC on EVM...";
      const transferRes = await fetch("/api/demo/transfer-evm-to-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount.toString() }),
      });
      const transferData = await transferRes.json();

      if (!transferRes.ok) throw new Error(transferData.error);

      addLog(`EVM transfer sent: ${transferData.txHash}`, "info");

      // Step 3: Poll reverse bridge status
      bridgeToAztecStatus = "Waiting for bridge to process...";
      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 5000));
        attempts++;

        const statusRes = await fetch(`/api/bridge/evm-to-aztec/status/${sessionId}`);
        const statusData = await statusRes.json();

        if (statusData.status === "completed") {
          bridgeToAztecStatus = "Bridge complete!";
          addLog(`Bridged ${bridgeToAztecAmount} bUSDC to Aztec`, "success");

          // Sync to discover new private notes
          if (minterAddress) {
            await registerSender(minterAddress);
          }
          await syncPXE();
          await refreshBalances();
          break;
        } else if (statusData.status === "expired" || statusData.status === "not_found") {
          throw new Error("Bridge session expired or not found");
        }

        bridgeToAztecStatus = `Waiting for bridge... (${attempts * 5}s)`;
      }

      if (attempts >= maxAttempts) {
        throw new Error("Bridge timed out");
      }
    } catch (error) {
      bridgeToAztecStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
      addLog(`Bridge to Aztec error: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      isBridgingToAztec = false;
    }
  }
</script>

{#if !serverReady || !aztecReady}
  <div class="loading-screen">
    <h1>Aztec Private Intent <span>Bridge</span></h1>
    <div class="loader">
      <div class="spinner"></div>
      <p class="loader-text">{initStatus}</p>
    </div>
  </div>
{:else}
  <main class="container fade-in">
    <header class="header">
      <h1>Aztec Private Intent <span>Bridge</span></h1>
      <div class="status-badge ready">
        <span class="status-dot"></span>
        Connected
      </div>
    </header>

    <!-- Account Cards -->
    <div class="accounts-grid">
      <div class="account-card aztec">
        <h3>Aztec (Private)</h3>
        <div class="label">Address</div>
        <div class="address">{userAccount ? truncateAddress(userAccount.address) : '...'}</div>
        <div class="balance">{aztecBalance} <span class="balance-label">USDC</span></div>
        <button
          class="btn btn-primary btn-sm btn-faucet"
          onclick={faucet}
          disabled={isFauceting}
        >
          {#if isFauceting}
            <span class="spinner btn-spinner"></span> Minting...
          {:else}
            Get Test USDC
          {/if}
        </button>
      </div>

      <div class="account-card evm">
        <h3>EVM (Anvil)</h3>
        <div class="label">Address</div>
        <div class="address">{truncateAddress(DEMO_EVM_ADDRESS)}</div>
        <div class="balance">{evmBalance} <span class="balance-label">bUSDC</span></div>
        <button class="btn btn-secondary btn-sm btn-faucet" onclick={refreshBalances} disabled={isRefreshing}>
          {#if isRefreshing}
            <span class="spinner btn-spinner"></span>
          {:else}
            Refresh
          {/if}
        </button>
      </div>
    </div>

    <!-- Bridge: Aztec -> EVM -->
    <div class="bridge-section">
      <h3>Aztec &rarr; EVM</h3>
      <div class="bridge-row">
        <div class="bridge-input">
          <label>Amount (USDC)</label>
          <input
            type="number"
            placeholder="0"
            min="1"
            step="1"
            bind:value={bridgeToEvmAmount}
            disabled={isBridgingToEvm}
          />
        </div>
        <button
          class="btn btn-primary"
          onclick={bridgeToEvm}
          disabled={isBridgingToEvm || !bridgeToEvmAmount}
        >
          {#if isBridgingToEvm}
            <span class="spinner btn-spinner"></span>
          {:else}
            Bridge &rarr;
          {/if}
        </button>
      </div>
      {#if bridgeToEvmStatus}
        <div class="bridge-status" class:pending={isBridgingToEvm} class:success={bridgeToEvmStatus.includes('complete')} class:error={bridgeToEvmStatus.includes('Error')}>
          {bridgeToEvmStatus}
        </div>
      {/if}
    </div>

    <!-- Bridge: EVM -> Aztec -->
    <div class="bridge-section">
      <h3>EVM &rarr; Aztec</h3>
      <div class="bridge-row">
        <div class="bridge-input">
          <label>Amount (bUSDC)</label>
          <input
            type="number"
            placeholder="0"
            min="1"
            step="1"
            bind:value={bridgeToAztecAmount}
            disabled={isBridgingToAztec}
          />
        </div>
        <button
          class="btn btn-primary"
          onclick={bridgeToAztec}
          disabled={isBridgingToAztec || !bridgeToAztecAmount}
        >
          {#if isBridgingToAztec}
            <span class="spinner btn-spinner"></span>
          {:else}
            &larr; Bridge
          {/if}
        </button>
      </div>
      {#if bridgeToAztecStatus}
        <div class="bridge-status" class:pending={isBridgingToAztec} class:success={bridgeToAztecStatus.includes('complete')} class:error={bridgeToAztecStatus.includes('Error')}>
          {bridgeToAztecStatus}
        </div>
      {/if}
    </div>

    <!-- Activity Log -->
    <div class="activity-log">
      <h3>Activity Log</h3>
      <div class="log-entries">
        {#each logEntries as entry}
          <div class="log-entry {entry.type}">
            <span class="timestamp">{entry.time}</span>
            {entry.text}
          </div>
        {/each}
        {#if logEntries.length === 0}
          <div class="log-entry">Waiting for initialization...</div>
        {/if}
      </div>
    </div>
  </main>
{/if}
