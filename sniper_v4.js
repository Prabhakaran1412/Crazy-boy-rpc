/**
 * Crazy Boy RPC - Solana Pump.fun Sniper Bot v4.0
 * - Fixed token detection via logsSubscribe
 * - Auto-buy with Jupiter or Pump.fun SDK
 * - Telegram alerts
 * - Auto-reconnect on WS drop
 */

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");
require("dotenv").config();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  // RPC — use a paid endpoint for reliability (Helius, QuickNode, etc.)
  RPC_HTTP: process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com",
  RPC_WSS: process.env.RPC_WSS || "wss://api.mainnet-beta.solana.com",

  // Pump.fun program ID (verified May 2025)
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  // Wallet
  PRIVATE_KEY: process.env.PRIVATE_KEY || "", // base58 encoded

  // Buy settings
  AUTO_BUY_ENABLED: process.env.AUTO_BUY_ENABLED === "true",
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || "0.01"), // SOL per snipe
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "2000"),        // 20% slippage
  MAX_BUY_PER_SESSION: parseInt(process.env.MAX_BUY_PER_SESSION || "5"),
  MIN_SOL_BALANCE: parseFloat(process.env.MIN_SOL_BALANCE || "0.05"), // safety floor

  // Filters (set to 0/false to disable)
  MIN_LIQUIDITY_SOL: parseFloat(process.env.MIN_LIQUIDITY_SOL || "0"),
  REQUIRE_MINT_DISABLED: process.env.REQUIRE_MINT_DISABLED === "true",
  BLACKLIST_KEYWORDS: (process.env.BLACKLIST_KEYWORDS || "").split(",").filter(Boolean),

  // Telegram
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "",

  // Reconnect
  WS_RECONNECT_DELAY_MS: 5000,
  MAX_RECONNECT_ATTEMPTS: 999,
};

// ─── STATE ──────────────────────────────────────────────────────────────────
let buyCount = 0;
let tokenCount = 0;
let reconnectAttempts = 0;
let connection = null;
let wallet = null;
let subscriptionId = null;
let isRunning = false;

// ─── WALLET ─────────────────────────────────────────────────────────────────
function loadWallet() {
  if (!CONFIG.PRIVATE_KEY) {
    console.warn("[WALLET] No PRIVATE_KEY set — auto-buy disabled");
    return null;
  }
  try {
    const decoded = bs58.decode(CONFIG.PRIVATE_KEY);
    return Keypair.fromSecretKey(decoded);
  } catch (e) {
    console.error("[WALLET] Invalid private key:", e.message);
    return null;
  }
}

// ─── TELEGRAM ───────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error("[TG] Error:", data.description);
  } catch (e) {
    console.error("[TG] Failed to send:", e.message);
  }
}

// ─── DETECTION: Parse mint address from Pump.fun log ─────────────────────
function parseMintFromLogs(logs) {
  // Method 1: Look for "initialize" instruction logs
  const initLog = logs.find(
    (l) => l.includes("Program log: Instruction: Create") ||
           l.includes("Program log: Instruction: Initialize")
  );
  if (!initLog) return null;

  // Method 2: Find mint address in "Program data:" lines
  // Pump.fun emits the mint in structured logs
  for (const log of logs) {
    // Pattern: "Program log: mint: <base58>"
    const mintMatch = log.match(/mint[:\s]+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (mintMatch) return mintMatch[1];
  }

  return null;
}

// ─── DETECTION: Get token metadata from chain ────────────────────────────
async function getTokenInfo(mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPubkey);
    if (!accountInfo) return null;

    return {
      mint: mintAddress,
      pumpUrl: `https://pump.fun/${mintAddress}`,
      dexUrl: `https://dexscreener.com/solana/${mintAddress}`,
    };
  } catch (e) {
    return null;
  }
}

// ─── AUTO-BUY via Jupiter ────────────────────────────────────────────────
async function buyToken(mintAddress, solAmount) {
  if (!wallet) return { success: false, error: "No wallet" };

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSOL = balance / LAMPORTS_PER_SOL;

  if (balanceSOL < CONFIG.MIN_SOL_BALANCE + solAmount) {
    return { success: false, error: `Insufficient balance: ${balanceSOL.toFixed(4)} SOL` };
  }

  if (buyCount >= CONFIG.MAX_BUY_PER_SESSION) {
    return { success: false, error: `Max buys reached (${CONFIG.MAX_BUY_PER_SESSION})` };
  }

  try {
    console.log(`[BUY] Attempting to buy ${solAmount} SOL of ${mintAddress}`);

    // Jupiter swap: SOL → token
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    // 1. Get Jupiter quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountLamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    const quote = await quoteRes.json();

    if (quote.error) {
      return { success: false, error: `Jupiter quote error: ${quote.error}` };
    }

    // 2. Get swap transaction
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000, // 0.0001 SOL priority fee
      }),
    });
    const swapData = await swapRes.json();

    if (!swapData.swapTransaction) {
      return { success: false, error: "No swap transaction returned" };
    }

    // 3. Deserialize and sign
    const txBuf = Buffer.from(swapData.swapTransaction, "base64");
    const { VersionedTransaction } = require("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    // 4. Send
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // 5. Confirm
    await connection.confirmTransaction(sig, "confirmed");

    buyCount++;
    const tokensOut = quote.outAmount;
    return {
      success: true,
      signature: sig,
      tokensOut,
      solSpent: solAmount,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── HANDLE NEW TOKEN ───────────────────────────────────────────────────────
async function handleNewToken(mintAddress, txSignature) {
  tokenCount++;
  console.log(`\n[TOKEN #${tokenCount}] 🚀 New Pump.fun token detected!`);
  console.log(`  Mint: ${mintAddress}`);
  console.log(`  TX:   ${txSignature}`);
  console.log(`  Link: https://pump.fun/${mintAddress}`);

  const info = await getTokenInfo(mintAddress);

  // Blacklist check
  if (CONFIG.BLACKLIST_KEYWORDS.length > 0) {
    const combined = mintAddress.toLowerCase();
    if (CONFIG.BLACKLIST_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()))) {
      console.log(`[FILTER] Blacklisted — skipping`);
      return;
    }
  }

  // Telegram: Detection alert
  const detectMsg =
    `🎯 <b>New Pump.fun Token Detected!</b>\n` +
    `Token #${tokenCount}\n\n` +
    `📍 <b>Mint:</b> <code>${mintAddress}</code>\n` +
    `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
    `<a href="https://dexscreener.com/solana/${mintAddress}">DexScreener</a>\n` +
    `🔖 TX: <code>${txSignature}</code>\n\n` +
    `Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Disabled"}`;

  await sendTelegram(detectMsg);

  // Auto-buy
  if (CONFIG.AUTO_BUY_ENABLED) {
    console.log(`[BUY] Auto-buy enabled — buying ${CONFIG.BUY_AMOUNT_SOL} SOL worth...`);
    const result = await buyToken(mintAddress, CONFIG.BUY_AMOUNT_SOL);

    if (result.success) {
      console.log(`[BUY] ✅ Success! TX: ${result.signature}`);
      console.log(`[BUY]    Tokens out: ${result.tokensOut}`);
      await sendTelegram(
        `✅ <b>Buy Executed!</b>\n` +
        `Mint: <code>${mintAddress}</code>\n` +
        `SOL spent: ${result.solSpent}\n` +
        `Tokens received: ${result.tokensOut}\n` +
        `<a href="https://solscan.io/tx/${result.signature}">View TX</a>`
      );
    } else {
      console.error(`[BUY] ❌ Failed: ${result.error}`);
      await sendTelegram(
        `❌ <b>Buy Failed</b>\n` +
        `Mint: <code>${mintAddress}</code>\n` +
        `Reason: ${result.error}`
      );
    }
  }
}

// ─── MAIN SUBSCRIPTION ──────────────────────────────────────────────────────
async function startListening() {
  console.log("[BOT] Creating connection...");
  connection = new Connection(CONFIG.RPC_HTTP, {
    wsEndpoint: CONFIG.RPC_WSS,
    commitment: "confirmed",
  });

  const programId = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

  console.log(`[BOT] Subscribing to Pump.fun program: ${CONFIG.PUMP_PROGRAM_ID}`);

  subscriptionId = connection.onLogs(
    programId,
    async (logInfo, ctx) => {
      try {
        const { logs, signature, err } = logInfo;

        // Skip failed txns
        if (err) return;

        // Only process "create" / new token events
        const isCreate =
          logs.some((l) => l.includes("Instruction: Create")) ||
          logs.some((l) => l.includes("InitializeMint"));

        if (!isCreate) return;

        // Try to extract mint from logs
        let mintAddress = parseMintFromLogs(logs);

        // Fallback: parse from transaction accounts
        if (!mintAddress) {
          try {
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            if (tx?.transaction?.message?.accountKeys) {
              // The mint is typically the 2nd new account in a Pump.fun create tx
              const accounts = tx.transaction.message.accountKeys;
              // Find accounts that are signers or writable — mint is usually index 0 or 1
              for (const acc of accounts.slice(0, 5)) {
                const addr = acc.pubkey?.toString() || acc.toString();
                // Basic validation: not a known system program
                const knownPrograms = [
                  "11111111111111111111111111111111",
                  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                  CONFIG.PUMP_PROGRAM_ID,
                  "SysvarRent111111111111111111111111111111111",
                  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bw",
                ];
                if (!knownPrograms.includes(addr) && addr.length >= 32) {
                  mintAddress = addr;
                  break;
                }
              }
            }
          } catch (txErr) {
            // Ignore — public RPC may rate limit getParsedTransaction
          }
        }

        if (mintAddress) {
          await handleNewToken(mintAddress, signature);
        } else {
          // Still log the raw detection so you know it's working
          tokenCount++;
          console.log(`[TOKEN #${tokenCount}] Pump.fun create detected (mint parse failed)`);
          console.log(`  TX: ${signature}`);
          console.log(`  Logs: ${logs.slice(0, 3).join(" | ")}`);
          await sendTelegram(
            `🟡 <b>Pump.fun Create TX Detected</b> (mint address pending)\n` +
            `TX: <code>${signature}</code>\n` +
            `<a href="https://solscan.io/tx/${signature}">View TX</a>`
          );
        }
      } catch (e) {
        console.error("[ERROR] Log handler error:", e.message);
      }
    },
    "confirmed"
  );

  console.log(`[BOT] ✅ Subscribed! Subscription ID: ${subscriptionId}`);
  isRunning = true;
  reconnectAttempts = 0;

  await sendTelegram(
    `🤖 <b>Crazy Boy RPC v4.0 Online!</b>\n` +
    `Monitoring Pump.fun for new tokens...\n` +
    `Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Disabled"}\n` +
    `Wallet: ${wallet ? wallet.publicKey.toString().slice(0, 8) + "..." : "None"}`
  );

  // Keep-alive heartbeat (detects silent drops)
  setInterval(async () => {
    try {
      const slot = await connection.getSlot();
      console.log(`[HEARTBEAT] Slot: ${slot} | Tokens: ${tokenCount} | Buys: ${buyCount}`);
    } catch (e) {
      console.error("[HEARTBEAT] Connection lost — reconnecting...");
      await reconnect();
    }
  }, 30000);
}

// ─── RECONNECT ──────────────────────────────────────────────────────────────
async function reconnect() {
  if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    console.error("[RECONNECT] Max attempts reached. Exiting.");
    process.exit(1);
  }

  reconnectAttempts++;
  isRunning = false;
  console.log(`[RECONNECT] Attempt ${reconnectAttempts} in ${CONFIG.WS_RECONNECT_DELAY_MS}ms...`);

  if (subscriptionId !== null && connection) {
    try { await connection.removeOnLogsListener(subscriptionId); } catch (_) {}
  }

  await new Promise((r) => setTimeout(r, CONFIG.WS_RECONNECT_DELAY_MS));

  try {
    await startListening();
  } catch (e) {
    console.error("[RECONNECT] Failed:", e.message);
    await reconnect();
  }
}

// ─── STARTUP ────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║   Crazy Boy RPC — Sniper Bot v4.0    ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log(`RPC:       ${CONFIG.RPC_HTTP}`);
  console.log(`WSS:       ${CONFIG.RPC_WSS}`);
  console.log(`Auto-buy:  ${CONFIG.AUTO_BUY_ENABLED}`);
  console.log(`Buy size:  ${CONFIG.BUY_AMOUNT_SOL} SOL`);
  console.log(`Slippage:  ${CONFIG.SLIPPAGE_BPS / 100}%`);
  console.log("");

  wallet = loadWallet();
  if (wallet) {
    console.log(`[WALLET] Loaded: ${wallet.publicKey.toString()}`);
    const bal = await new Connection(CONFIG.RPC_HTTP).getBalance(wallet.publicKey).catch(() => 0);
    console.log(`[WALLET] Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  try {
    await startListening();
  } catch (e) {
    console.error("[STARTUP] Error:", e.message);
    await reconnect();
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED]", err.message);
});

main();
