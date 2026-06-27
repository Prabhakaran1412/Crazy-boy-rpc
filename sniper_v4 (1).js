/**
 * Crazy Boy RPC - Solana Pump.fun Sniper Bot v4.0
 * - Fixed token detection via logsSubscribe
 * - Auto-buy with Jupiter
 * - Telegram alerts with rate limiting
 * - Auto-reconnect on WS drop
 */

const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");
require("dotenv").config();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  RPC_HTTP: process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com",
  RPC_WSS: process.env.RPC_WSS || "wss://api.mainnet-beta.solana.com",
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",
  AUTO_BUY_ENABLED: process.env.AUTO_BUY_ENABLED === "true",
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || "0.01"),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "2000"),
  MAX_BUY_PER_SESSION: parseInt(process.env.MAX_BUY_PER_SESSION || "5"),
  MIN_SOL_BALANCE: parseFloat(process.env.MIN_SOL_BALANCE || "0.05"),
  BLACKLIST_KEYWORDS: (process.env.BLACKLIST_KEYWORDS || "").split(",").filter(Boolean),
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "",
  // Only send Telegram alert every N tokens (to avoid spam)
  TG_ALERT_EVERY: parseInt(process.env.TG_ALERT_EVERY || "1"),
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
let lastTgSent = 0; // timestamp of last telegram message

// ─── WALLET ─────────────────────────────────────────────────────────────────
function loadWallet() {
  if (!CONFIG.PRIVATE_KEY) {
    console.log("[WALLET] No PRIVATE_KEY set — auto-buy disabled");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
  } catch (e) {
    console.error("[WALLET] Invalid private key:", e.message);
    return null;
  }
}

// ─── TELEGRAM ───────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) {
    console.log("[TG] Skipping — no token or chat ID configured");
    return;
  }

  // Rate limit: min 2 seconds between messages
  const now = Date.now();
  if (now - lastTgSent < 2000) {
    await new Promise(r => setTimeout(r, 2000 - (now - lastTgSent)));
  }

  try {
    const url = `https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`;
    console.log(`[TG] Sending alert to chat ${CONFIG.TG_CHAT_ID}...`);
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
    if (data.ok) {
      console.log("[TG] ✅ Alert sent successfully!");
      lastTgSent = Date.now();
    } else {
      console.error("[TG] ❌ Failed:", JSON.stringify(data));
    }
  } catch (e) {
    console.error("[TG] ❌ Error:", e.message);
  }
}

// ─── DETECTION: Parse mint from logs ────────────────────────────────────────
function parseMintFromLogs(logs) {
  for (const log of logs) {
    const mintMatch = log.match(/mint[:\s]+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (mintMatch) return mintMatch[1];
  }
  return null;
}

// ─── AUTO-BUY via Jupiter ────────────────────────────────────────────────────
async function buyToken(mintAddress, solAmount) {
  if (!wallet) return { success: false, error: "No wallet" };

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSOL = balance / LAMPORTS_PER_SOL;
  if (balanceSOL < CONFIG.MIN_SOL_BALANCE + solAmount) {
    return { success: false, error: `Low balance: ${balanceSOL.toFixed(4)} SOL` };
  }
  if (buyCount >= CONFIG.MAX_BUY_PER_SESSION) {
    return { success: false, error: `Max buys reached (${CONFIG.MAX_BUY_PER_SESSION})` };
  }

  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountLamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
    );
    const quote = await quoteRes.json();
    if (quote.error) return { success: false, error: `Quote: ${quote.error}` };

    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000,
      }),
    });
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) return { success: false, error: "No swap tx" };

    const { VersionedTransaction } = require("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    buyCount++;
    return { success: true, signature: sig, tokensOut: quote.outAmount, solSpent: solAmount };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── HANDLE NEW TOKEN ────────────────────────────────────────────────────────
async function handleNewToken(mintAddress, txSignature) {
  tokenCount++;
  console.log(`\n[TOKEN #${tokenCount}] 🚀 New Pump.fun token!`);
  console.log(`  Mint: ${mintAddress}`);
  console.log(`  TX:   ${txSignature}`);
  console.log(`  Link: https://pump.fun/${mintAddress}`);

  // Blacklist check
  if (CONFIG.BLACKLIST_KEYWORDS.some(kw => mintAddress.toLowerCase().includes(kw.toLowerCase()))) {
    console.log(`[FILTER] Blacklisted — skipping`);
    return;
  }

  // Send Telegram only every TG_ALERT_EVERY tokens (default: every token)
  if (tokenCount % CONFIG.TG_ALERT_EVERY === 0) {
    const msg =
      `🎯 <b>New Pump.fun Token! #${tokenCount}</b>\n\n` +
      `📍 <b>Mint:</b> <code>${mintAddress}</code>\n` +
      `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
      `<a href="https://dexscreener.com/solana/${mintAddress}">DexScreener</a>\n` +
      `🤖 Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Off"}`;
    await sendTelegram(msg);
  }

  // Auto-buy
  if (CONFIG.AUTO_BUY_ENABLED) {
    const result = await buyToken(mintAddress, CONFIG.BUY_AMOUNT_SOL);
    if (result.success) {
      console.log(`[BUY] ✅ TX: ${result.signature}`);
      await sendTelegram(
        `✅ <b>Buy Done!</b>\n` +
        `Mint: <code>${mintAddress}</code>\n` +
        `SOL: ${result.solSpent} | Tokens: ${result.tokensOut}\n` +
        `<a href="https://solscan.io/tx/${result.signature}">View TX</a>`
      );
    } else {
      console.error(`[BUY] ❌ ${result.error}`);
    }
  }
}

// ─── MAIN SUBSCRIPTION ───────────────────────────────────────────────────────
async function startListening() {
  console.log("[BOT] Creating connection...");
  connection = new Connection(CONFIG.RPC_HTTP, {
    wsEndpoint: CONFIG.RPC_WSS,
    commitment: "confirmed",
  });

  const programId = new PublicKey(CONFIG.PUMP_PROGRAM_ID);
  console.log(`[BOT] Subscribing to Pump.fun: ${CONFIG.PUMP_PROGRAM_ID}`);

  subscriptionId = connection.onLogs(
    programId,
    async (logInfo) => {
      try {
        const { logs, signature, err } = logInfo;
        if (err) return;
        const isCreate =
          logs.some(l => l.includes("Instruction: Create")) ||
          logs.some(l => l.includes("InitializeMint"));
        if (!isCreate) return;

        let mintAddress = parseMintFromLogs(logs);

        if (!mintAddress) {
          try {
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });
            const knownPrograms = [
              "11111111111111111111111111111111",
              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              CONFIG.PUMP_PROGRAM_ID,
              "SysvarRent111111111111111111111111111111111",
              "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bw",
            ];
            const accounts = tx?.transaction?.message?.accountKeys || [];
            for (const acc of accounts.slice(0, 5)) {
              const addr = acc.pubkey?.toString() || acc.toString();
              if (!knownPrograms.includes(addr) && addr.length >= 32) {
                mintAddress = addr;
                break;
              }
            }
          } catch (_) {}
        }

        if (mintAddress) {
          await handleNewToken(mintAddress, signature);
        }
      } catch (e) {
        console.error("[ERROR]", e.message);
      }
    },
    "confirmed"
  );

  console.log(`[BOT] ✅ Subscribed! ID: ${subscriptionId}`);
  reconnectAttempts = 0;

  // Send startup alert
  await sendTelegram(
    `🤖 <b>Crazy Boy RPC v4.0 Online!</b>\n` +
    `Monitoring Pump.fun for new tokens...\n` +
    `Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Disabled"}`
  );

  // Heartbeat every 60s
  setInterval(async () => {
    try {
      const slot = await connection.getSlot();
      console.log(`[HEARTBEAT] Slot: ${slot} | Tokens: ${tokenCount} | Buys: ${buyCount}`);
    } catch (e) {
      console.error("[HEARTBEAT] Lost connection — reconnecting...");
      await reconnect();
    }
  }, 60000);
}

// ─── RECONNECT ───────────────────────────────────────────────────────────────
async function reconnect() {
  reconnectAttempts++;
  console.log(`[RECONNECT] Attempt ${reconnectAttempts}...`);
  if (subscriptionId !== null && connection) {
    try { await connection.removeOnLogsListener(subscriptionId); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, CONFIG.WS_RECONNECT_DELAY_MS));
  try {
    await startListening();
  } catch (e) {
    console.error("[RECONNECT] Failed:", e.message);
    await reconnect();
  }
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║   Crazy Boy RPC — Sniper Bot v4.0    ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log(`RPC:      ${CONFIG.RPC_HTTP}`);
  console.log(`TG Token: ${CONFIG.TG_BOT_TOKEN ? CONFIG.TG_BOT_TOKEN.slice(0,10)+"..." : "NOT SET"}`);
  console.log(`TG Chat:  ${CONFIG.TG_CHAT_ID || "NOT SET"}`);
  console.log(`Auto-buy: ${CONFIG.AUTO_BUY_ENABLED}`);
  console.log("");

  wallet = loadWallet();
  if (wallet) console.log(`[WALLET] ${wallet.publicKey.toString()}`);

  try {
    await startListening();
  } catch (e) {
    console.error("[STARTUP]", e.message);
    await reconnect();
  }
}

process.on("unhandledRejection", err => console.error("[UNHANDLED]", err?.message));
main();
