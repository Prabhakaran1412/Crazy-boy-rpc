/**
 * Crazy Boy RPC - Solana Pump.fun Sniper Bot v4.0
 * - Fixed mint detection using Pump.fun event data
 * - Buy alerts only
 * - Auto-reconnect
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
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "",
  // Alert on every token detection (set to 999999 for buy-only alerts)
  TG_ALERT_EVERY: parseInt(process.env.TG_ALERT_EVERY || "999999"),
  WS_RECONNECT_DELAY_MS: 5000,
};

// Known Pump.fun / Solana program addresses to exclude
const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "SysvarRent111111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bw",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "ComputeBudget111111111111111111111111111111",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F", // Pump.fun fee account
  "4wTV81ej3G4uoJsHKoNPBXv2DFCuNMCMXbEEFqKrvKGM", // Pump.fun bonding curve
  "CebN5WGQ4jvEPvsVU4EoHEpgznyzmDkKMHRmA4AqKZv8", // Pump.fun creator vault
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",  // Pump.fun treasury
]);

// ─── STATE ──────────────────────────────────────────────────────────────────
let buyCount = 0;
let tokenCount = 0;
let reconnectAttempts = 0;
let connection = null;
let wallet = null;
let subscriptionId = null;
let lastTgSent = 0;
const seenMints = new Set(); // avoid duplicate alerts

// ─── WALLET ─────────────────────────────────────────────────────────────────
function loadWallet() {
  if (!CONFIG.PRIVATE_KEY) {
    console.log("[WALLET] No PRIVATE_KEY — auto-buy disabled");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
  } catch (e) {
    console.error("[WALLET] Invalid key:", e.message);
    return null;
  }
}

// ─── TELEGRAM ───────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;
  const now = Date.now();
  if (now - lastTgSent < 1000) await new Promise(r => setTimeout(r, 1000));
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`, {
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
      console.log("[TG] ✅ Sent!");
      lastTgSent = Date.now();
    } else {
      console.error("[TG] ❌", JSON.stringify(data));
    }
  } catch (e) {
    console.error("[TG] Error:", e.message);
  }
}

// ─── VERIFY MINT IS REAL TOKEN ───────────────────────────────────────────────
async function verifyMint(mintAddress) {
  try {
    const pubkey = new PublicKey(mintAddress);
    const info = await connection.getAccountInfo(pubkey);
    if (!info) return false;
    // Token mint accounts are exactly 82 bytes and owned by Token program
    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    return info.owner.toString() === TOKEN_PROGRAM && info.data.length === 82;
  } catch (e) {
    return false;
  }
}

// ─── EXTRACT MINT FROM TRANSACTION ───────────────────────────────────────────
async function extractMintFromTx(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return null;

    const accounts = tx.transaction.message.accountKeys || [];

    // Strategy 1: Find account owned by Token program with mint data (82 bytes)
    // These are the actual token mints — check innerInstructions for InitializeMint
    const innerIxs = tx.meta?.innerInstructions || [];
    for (const inner of innerIxs) {
      for (const ix of inner.instructions) {
        if (ix.parsed?.type === "initializeMint" || ix.parsed?.type === "initializeMint2") {
          const mint = ix.parsed?.info?.mint;
          if (mint) {
            console.log(`[MINT] Found via initializeMint: ${mint}`);
            return mint;
          }
        }
      }
    }

    // Strategy 2: Check top-level instructions
    const topIxs = tx.transaction.message.instructions || [];
    for (const ix of topIxs) {
      if (ix.parsed?.type === "initializeMint" || ix.parsed?.type === "initializeMint2") {
        const mint = ix.parsed?.info?.mint;
        if (mint) {
          console.log(`[MINT] Found via top-level initializeMint: ${mint}`);
          return mint;
        }
      }
    }

    // Strategy 3: Check all accounts — find one owned by Token program with 82 bytes
    for (const acc of accounts) {
      const addr = acc.pubkey?.toString();
      if (!addr || KNOWN_PROGRAMS.has(addr)) continue;
      // Skip if it's a signer (likely the creator wallet)
      if (acc.signer) continue;
      // Verify on-chain
      const isMint = await verifyMint(addr);
      if (isMint && !seenMints.has(addr)) {
        console.log(`[MINT] Found via account verification: ${addr}`);
        return addr;
      }
    }

    return null;
  } catch (e) {
    console.error("[EXTRACT]", e.message);
    return null;
  }
}

// ─── AUTO-BUY ────────────────────────────────────────────────────────────────
async function buyToken(mintAddress) {
  if (!wallet) return { success: false, error: "No wallet configured" };
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSOL = balance / LAMPORTS_PER_SOL;
  if (balanceSOL < CONFIG.MIN_SOL_BALANCE + CONFIG.BUY_AMOUNT_SOL) {
    return { success: false, error: `Low balance: ${balanceSOL.toFixed(4)} SOL` };
  }
  if (buyCount >= CONFIG.MAX_BUY_PER_SESSION) {
    return { success: false, error: `Max buys (${CONFIG.MAX_BUY_PER_SESSION}) reached` };
  }
  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const amountLamports = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
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
    if (!swapData.swapTransaction) return { success: false, error: "No swap tx returned" };

    const { VersionedTransaction } = require("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    buyCount++;
    return { success: true, signature: sig, tokensOut: quote.outAmount };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── HANDLE NEW TOKEN ────────────────────────────────────────────────────────
async function handleNewToken(mintAddress, txSignature) {
  // Deduplicate
  if (seenMints.has(mintAddress)) return;
  seenMints.add(mintAddress);

  tokenCount++;
  console.log(`\n[TOKEN #${tokenCount}] 🚀 Verified Pump.fun token!`);
  console.log(`  Mint: ${mintAddress}`);
  console.log(`  TX:   ${txSignature}`);
  console.log(`  Link: https://pump.fun/${mintAddress}`);

  // Detection alert (only if TG_ALERT_EVERY is set low)
  if (tokenCount % CONFIG.TG_ALERT_EVERY === 0) {
    await sendTelegram(
      `🎯 <b>New Token #${tokenCount}</b>\n\n` +
      `📍 <code>${mintAddress}</code>\n` +
      `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
      `<a href="https://dexscreener.com/solana/${mintAddress}">DexScreener</a>`
    );
  }

  // Auto-buy
  if (CONFIG.AUTO_BUY_ENABLED) {
    console.log(`[BUY] Buying ${CONFIG.BUY_AMOUNT_SOL} SOL of ${mintAddress}...`);
    const result = await buyToken(mintAddress);
    if (result.success) {
      console.log(`[BUY] ✅ TX: ${result.signature}`);
      await sendTelegram(
        `✅ <b>Buy Executed!</b>\n\n` +
        `📍 Mint: <code>${mintAddress}</code>\n` +
        `💰 SOL spent: ${CONFIG.BUY_AMOUNT_SOL}\n` +
        `🪙 Tokens: ${result.tokensOut}\n` +
        `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a>\n` +
        `📋 <a href="https://solscan.io/tx/${result.signature}">View TX</a>`
      );
    } else {
      console.error(`[BUY] ❌ ${result.error}`);
      await sendTelegram(`❌ <b>Buy Failed</b>\nMint: <code>${mintAddress}</code>\nReason: ${result.error}`);
    }
  }
}

// ─── MAIN LISTENER ───────────────────────────────────────────────────────────
async function startListening() {
  console.log("[BOT] Connecting...");
  connection = new Connection(CONFIG.RPC_HTTP, {
    wsEndpoint: CONFIG.RPC_WSS,
    commitment: "confirmed",
  });

  const programId = new PublicKey(CONFIG.PUMP_PROGRAM_ID);
  console.log(`[BOT] Subscribing to Pump.fun logs...`);

  subscriptionId = connection.onLogs(
    programId,
    async ({ logs, signature, err }) => {
      try {
        if (err) return;

        // Only process token creation events
        const isCreate =
          logs.some(l => l.includes("Instruction: Create")) ||
          logs.some(l => l.includes("InitializeMint"));
        if (!isCreate) return;

        // Extract real mint address from transaction
        const mintAddress = await extractMintFromTx(signature);
        if (mintAddress) {
          await handleNewToken(mintAddress, signature);
        } else {
          console.log(`[SKIP] Could not extract mint from TX: ${signature.slice(0,20)}...`);
        }
      } catch (e) {
        console.error("[LOG HANDLER]", e.message);
      }
    },
    "confirmed"
  );

  console.log(`[BOT] ✅ Subscribed! ID: ${subscriptionId}`);
  reconnectAttempts = 0;

  await sendTelegram(
    `🤖 <b>Crazy Boy RPC v4.0 Online!</b>\n` +
    `Monitoring Pump.fun...\n` +
    `Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Off"}`
  );

  // Heartbeat every 60s
  setInterval(async () => {
    try {
      const slot = await connection.getSlot();
      console.log(`[HEARTBEAT] Slot: ${slot} | Tokens: ${tokenCount} | Buys: ${buyCount}`);
    } catch (e) {
      console.error("[HEARTBEAT] Connection lost — reconnecting...");
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
  try { await startListening(); } catch (e) { await reconnect(); }
}

// ─── START ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║   Crazy Boy RPC — Sniper Bot v4.0    ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log(`RPC:      ${CONFIG.RPC_HTTP}`);
  console.log(`Auto-buy: ${CONFIG.AUTO_BUY_ENABLED}`);
  console.log(`TG Chat:  ${CONFIG.TG_CHAT_ID || "NOT SET"}`);
  console.log("");

  wallet = loadWallet();
  if (wallet) console.log(`[WALLET] ${wallet.publicKey.toString()}`);

  try { await startListening(); }
  catch (e) { console.error("[STARTUP]", e.message); await reconnect(); }
}

process.on("unhandledRejection", err => console.error("[UNHANDLED]", err?.message));
main();
