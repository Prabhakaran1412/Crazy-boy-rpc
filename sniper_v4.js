/**
 * Crazy Boy RPC - Solana Pump.fun Sniper Bot v6.0
 * - 9 on-chain filters
 * - Auto-buy via Jupiter
 * - Ladder sell: 50% at 2x, 30% at 5x, 20% at 10x
 * - Stop loss: sell 100% at -40%
 * - Telegram alerts on buy + each sell
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
  RPC_WSS:  process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com",
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  // Wallet
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",

  // Buy settings
  AUTO_BUY_ENABLED:    process.env.AUTO_BUY_ENABLED === "true",
  BUY_AMOUNT_SOL:      parseFloat(process.env.BUY_AMOUNT_SOL   || "0.01"),
  SLIPPAGE_BPS:        parseInt(process.env.SLIPPAGE_BPS        || "2000"),
  MAX_BUY_PER_SESSION: parseInt(process.env.MAX_BUY_PER_SESSION || "5"),
  MIN_SOL_BALANCE:     parseFloat(process.env.MIN_SOL_BALANCE   || "0.05"),

  // ── LADDER SELL ──────────────────────────────────────────────────────────
  // Sell 50% at 2x, 30% at 5x, 20% at 10x
  TP1_MULTIPLIER: parseFloat(process.env.TP1_MULTIPLIER || "2"),   // 2x
  TP1_SELL_PCT:   parseFloat(process.env.TP1_SELL_PCT   || "50"),  // sell 50%
  TP2_MULTIPLIER: parseFloat(process.env.TP2_MULTIPLIER || "5"),   // 5x
  TP2_SELL_PCT:   parseFloat(process.env.TP2_SELL_PCT   || "30"),  // sell 30%
  TP3_MULTIPLIER: parseFloat(process.env.TP3_MULTIPLIER || "10"),  // 10x
  TP3_SELL_PCT:   parseFloat(process.env.TP3_SELL_PCT   || "20"),  // sell 20%
  STOP_LOSS_PCT:  parseFloat(process.env.STOP_LOSS_PCT  || "40"),  // -40% stop loss
  PRICE_CHECK_INTERVAL_MS: parseInt(process.env.PRICE_CHECK_INTERVAL_MS || "10000"), // check every 10s

  // ── FILTERS ──────────────────────────────────────────────────────────────
  FILTER_REQUIRE_MINT_REVOKED:   process.env.FILTER_REQUIRE_MINT_REVOKED   !== "false",
  FILTER_REQUIRE_FREEZE_REVOKED: process.env.FILTER_REQUIRE_FREEZE_REVOKED !== "false",
  FILTER_MIN_BONDING_SOL:        parseFloat(process.env.FILTER_MIN_BONDING_SOL  || "1"),
  FILTER_MAX_BONDING_SOL:        parseFloat(process.env.FILTER_MAX_BONDING_SOL  || "50"),
  FILTER_MIN_DEPLOYER_BALANCE:   parseFloat(process.env.FILTER_MIN_DEPLOYER_BALANCE || "0.1"),
  FILTER_MAX_TOP10_HOLDER_PCT:   parseFloat(process.env.FILTER_MAX_TOP10_HOLDER_PCT || "30"),
  FILTER_REQUIRE_SOCIAL:         process.env.FILTER_REQUIRE_SOCIAL         !== "false",
  FILTER_HOLDER_WAIT_MS:         parseInt(process.env.FILTER_HOLDER_WAIT_MS || "15000"),
  FILTER_BLACKLIST_KEYWORDS:     (process.env.FILTER_BLACKLIST_KEYWORDS || "test,rug,safe,elon,trump,scam,fake,honey,honeypot").split(",").filter(Boolean),

  // Telegram
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID:   process.env.TG_CHAT_ID   || "",

  WS_RECONNECT_DELAY_MS: 5000,
};

const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "SysvarRent111111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bw",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "ComputeBudget111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

// ─── STATE ───────────────────────────────────────────────────────────────────
let tokenCount = 0;
let buyCount   = 0;
let skipCount  = 0;
let reconnectAttempts = 0;
let connection = null;
let wallet     = null;
let subscriptionId = null;
let lastTgSent = 0;
const seenMints = new Set();

// Active positions being monitored for sell
// { mintAddress: { buyPrice, tokensHeld, tp1Done, tp2Done, tp3Done, stopLossDone, name, symbol } }
const positions = {};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadWallet() {
  if (!CONFIG.PRIVATE_KEY) { console.log("[WALLET] No PRIVATE_KEY — auto-buy disabled"); return null; }
  try { return Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch (e) { console.error("[WALLET] Invalid key:", e.message); return null; }
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;
  const now = Date.now();
  if (now - lastTgSent < 1500) await sleep(1500 - (now - lastTgSent));
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
    if (data.ok) { console.log("[TG] ✅ Sent!"); lastTgSent = Date.now(); }
    else console.error("[TG] ❌", JSON.stringify(data));
  } catch (e) { console.error("[TG] Error:", e.message); }
}

// ─── GET TOKEN PRICE via Jupiter ─────────────────────────────────────────────
async function getTokenPrice(mintAddress) {
  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const amount = 1000000; // 1 token (assuming 6 decimals)
    const res = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=5000`
    );
    const data = await res.json();
    if (data.error || !data.outAmount) return null;
    // Price in SOL per 1M tokens
    return parseFloat(data.outAmount) / LAMPORTS_PER_SOL;
  } catch (e) {
    return null;
  }
}

// ─── SELL TOKENS via Jupiter ──────────────────────────────────────────────────
async function sellTokens(mintAddress, sellPct, reason) {
  if (!wallet) return { success: false, error: "No wallet" };
  const pos = positions[mintAddress];
  if (!pos) return { success: false, error: "No position found" };

  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // Get token account balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mintAddress),
    });
    if (!tokenAccounts.value.length) return { success: false, error: "No token account found" };

    const tokenAccount = tokenAccounts.value[0];
    const totalTokens = BigInt(tokenAccount.account.data.parsed.info.tokenAmount.amount);
    if (totalTokens === 0n) return { success: false, error: "Zero token balance" };

    // Calculate how many to sell
    const sellAmount = (totalTokens * BigInt(Math.floor(sellPct))) / 100n;
    if (sellAmount === 0n) return { success: false, error: "Sell amount is 0" };

    console.log(`[SELL] ${reason}: selling ${sellPct}% (${sellAmount} tokens) of ${mintAddress.slice(0,8)}...`);

    // Jupiter quote: token → SOL
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${sellAmount}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
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

    const solReceived = parseFloat(quote.outAmount) / LAMPORTS_PER_SOL;
    return { success: true, signature: sig, solReceived, sellAmount: sellAmount.toString() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── MONITOR POSITION (ladder sell) ──────────────────────────────────────────
async function monitorPosition(mintAddress) {
  const pos = positions[mintAddress];
  if (!pos) return;

  console.log(`[MONITOR] Watching ${pos.symbol || mintAddress.slice(0,8)}... buy price: ${pos.buyPrice.toFixed(8)} SOL`);

  const interval = setInterval(async () => {
    try {
      const pos = positions[mintAddress];
      if (!pos) { clearInterval(interval); return; }

      // All targets hit — stop monitoring
      if (pos.tp1Done && pos.tp2Done && pos.tp3Done) {
        console.log(`[MONITOR] All targets hit for ${pos.symbol} — stopping monitor`);
        clearInterval(interval);
        delete positions[mintAddress];
        return;
      }

      const currentPrice = await getTokenPrice(mintAddress);
      if (!currentPrice) return; // skip if price unavailable

      const multiplier = currentPrice / pos.buyPrice;
      const changePct  = (multiplier - 1) * 100;

      console.log(`[MONITOR] ${pos.symbol || mintAddress.slice(0,8)}: ${multiplier.toFixed(2)}x (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`);

      // ── STOP LOSS: -40% ──────────────────────────────────────────────────
      if (!pos.stopLossDone && changePct <= -CONFIG.STOP_LOSS_PCT) {
        pos.stopLossDone = true;
        console.log(`[SELL] 🛑 Stop loss triggered at ${changePct.toFixed(1)}%`);
        const result = await sellTokens(mintAddress, 100, "STOP LOSS");
        clearInterval(interval);
        delete positions[mintAddress];
        if (result.success) {
          await sendTelegram(
            `🛑 <b>Stop Loss Hit!</b>\n\n` +
            `🪙 <b>${pos.name} (${pos.symbol})</b>\n` +
            `📍 <code>${mintAddress}</code>\n\n` +
            `📉 Loss: <b>${changePct.toFixed(1)}%</b>\n` +
            `💰 SOL recovered: ${result.solReceived.toFixed(4)}\n` +
            `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
            `<a href="https://solscan.io/tx/${result.signature}">TX</a>`
          );
        }
        return;
      }

      // ── TAKE PROFIT 1: 2x → sell 50% ────────────────────────────────────
      if (!pos.tp1Done && multiplier >= CONFIG.TP1_MULTIPLIER) {
        pos.tp1Done = true;
        console.log(`[SELL] 🎯 TP1 hit: ${multiplier.toFixed(2)}x — selling ${CONFIG.TP1_SELL_PCT}%`);
        const result = await sellTokens(mintAddress, CONFIG.TP1_SELL_PCT, "TP1");
        if (result.success) {
          await sendTelegram(
            `🎯 <b>Take Profit 1 Hit! (${CONFIG.TP1_MULTIPLIER}x)</b>\n\n` +
            `🪙 <b>${pos.name} (${pos.symbol})</b>\n` +
            `📍 <code>${mintAddress}</code>\n\n` +
            `📈 Gain: <b>+${changePct.toFixed(1)}%</b>\n` +
            `💰 Sold ${CONFIG.TP1_SELL_PCT}% → ${result.solReceived.toFixed(4)} SOL received\n` +
            `⏳ Holding remaining ${100 - CONFIG.TP1_SELL_PCT}% for ${CONFIG.TP2_MULTIPLIER}x\n` +
            `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
            `<a href="https://solscan.io/tx/${result.signature}">TX</a>`
          );
        }
        return;
      }

      // ── TAKE PROFIT 2: 5x → sell 30% ────────────────────────────────────
      if (pos.tp1Done && !pos.tp2Done && multiplier >= CONFIG.TP2_MULTIPLIER) {
        pos.tp2Done = true;
        console.log(`[SELL] 🎯 TP2 hit: ${multiplier.toFixed(2)}x — selling ${CONFIG.TP2_SELL_PCT}%`);
        const result = await sellTokens(mintAddress, CONFIG.TP2_SELL_PCT, "TP2");
        if (result.success) {
          await sendTelegram(
            `🎯 <b>Take Profit 2 Hit! (${CONFIG.TP2_MULTIPLIER}x)</b>\n\n` +
            `🪙 <b>${pos.name} (${pos.symbol})</b>\n` +
            `📍 <code>${mintAddress}</code>\n\n` +
            `📈 Gain: <b>+${changePct.toFixed(1)}%</b>\n` +
            `💰 Sold ${CONFIG.TP2_SELL_PCT}% → ${result.solReceived.toFixed(4)} SOL received\n` +
            `🚀 Holding last ${100 - CONFIG.TP1_SELL_PCT - CONFIG.TP2_SELL_PCT}% for ${CONFIG.TP3_MULTIPLIER}x moon bag!\n` +
            `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
            `<a href="https://solscan.io/tx/${result.signature}">TX</a>`
          );
        }
        return;
      }

      // ── TAKE PROFIT 3: 10x → sell remaining 20% ─────────────────────────
      if (pos.tp1Done && pos.tp2Done && !pos.tp3Done && multiplier >= CONFIG.TP3_MULTIPLIER) {
        pos.tp3Done = true;
        console.log(`[SELL] 🎯 TP3 hit: ${multiplier.toFixed(2)}x — selling remaining ${CONFIG.TP3_SELL_PCT}%`);
        const result = await sellTokens(mintAddress, 100, "TP3 FINAL"); // sell all remaining
        clearInterval(interval);
        delete positions[mintAddress];
        if (result.success) {
          await sendTelegram(
            `🏆 <b>Take Profit 3 Hit! (${CONFIG.TP3_MULTIPLIER}x) — FULLY EXITED!</b>\n\n` +
            `🪙 <b>${pos.name} (${pos.symbol})</b>\n` +
            `📍 <code>${mintAddress}</code>\n\n` +
            `📈 Total gain: <b>+${changePct.toFixed(1)}%</b>\n` +
            `💰 Final sell → ${result.solReceived.toFixed(4)} SOL received\n` +
            `✅ Position fully closed!\n` +
            `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
            `<a href="https://solscan.io/tx/${result.signature}">TX</a>`
          );
        }
      }

    } catch (e) {
      console.error(`[MONITOR] Error for ${mintAddress.slice(0,8)}:`, e.message);
    }
  }, CONFIG.PRICE_CHECK_INTERVAL_MS);
}

// ─── MINT EXTRACTION ─────────────────────────────────────────────────────────
async function extractMintFromTx(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return null;

    for (const inner of (tx.meta?.innerInstructions || [])) {
      for (const ix of inner.instructions) {
        if (ix.parsed?.type === "initializeMint" || ix.parsed?.type === "initializeMint2") {
          const mint = ix.parsed?.info?.mint;
          if (mint && !KNOWN_PROGRAMS.has(mint)) return mint;
        }
      }
    }
    for (const ix of (tx.transaction.message.instructions || [])) {
      if (ix.parsed?.type === "initializeMint" || ix.parsed?.type === "initializeMint2") {
        const mint = ix.parsed?.info?.mint;
        if (mint && !KNOWN_PROGRAMS.has(mint)) return mint;
      }
    }
    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    for (const acc of (tx.transaction.message.accountKeys || []).slice(0, 8)) {
      const addr = acc.pubkey?.toString();
      if (!addr || KNOWN_PROGRAMS.has(addr) || acc.signer) continue;
      try {
        const info = await connection.getAccountInfo(new PublicKey(addr));
        if (info && info.owner.toString() === TOKEN_PROGRAM && info.data.length === 82) return addr;
      } catch (_) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── FILTERS ─────────────────────────────────────────────────────────────────
async function checkAuthorities(mintAddress) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const data = info.value?.data?.parsed?.info;
    if (!data) return { pass: false, reason: "Could not fetch mint info" };
    if (CONFIG.FILTER_REQUIRE_MINT_REVOKED && data.mintAuthority !== null)
      return { pass: false, reason: "Mint authority NOT revoked" };
    if (CONFIG.FILTER_REQUIRE_FREEZE_REVOKED && data.freezeAuthority !== null)
      return { pass: false, reason: "Freeze authority NOT revoked" };
    return { pass: true };
  } catch (e) { return { pass: false, reason: "Authority check failed" }; }
}

async function checkBondingCurve(mintAddress) {
  try {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mintAddress).toBuffer()],
      new PublicKey(CONFIG.PUMP_PROGRAM_ID)
    );
    const balance = await connection.getBalance(bondingCurve);
    const sol = balance / LAMPORTS_PER_SOL;
    if (sol < CONFIG.FILTER_MIN_BONDING_SOL) return { pass: false, reason: `Bonding curve too low: ${sol.toFixed(3)} SOL` };
    if (sol > CONFIG.FILTER_MAX_BONDING_SOL) return { pass: false, reason: `Bonding curve too high: ${sol.toFixed(3)} SOL` };
    return { pass: true, solBalance: sol };
  } catch (e) { return { pass: false, reason: "Bonding curve check failed" }; }
}

async function checkDeployerBalance(txSignature) {
  try {
    const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const deployer = tx?.transaction?.message?.accountKeys?.[0]?.pubkey?.toString();
    if (!deployer) return { pass: true };
    const balance = await connection.getBalance(new PublicKey(deployer));
    const sol = balance / LAMPORTS_PER_SOL;
    if (sol < CONFIG.FILTER_MIN_DEPLOYER_BALANCE) return { pass: false, reason: `Deployer balance too low: ${sol.toFixed(3)} SOL` };
    return { pass: true, deployerBalance: sol };
  } catch (e) { return { pass: true }; }
}

function checkBlacklist(mintAddress) {
  for (const kw of CONFIG.FILTER_BLACKLIST_KEYWORDS) {
    if (mintAddress.toLowerCase().includes(kw.toLowerCase()))
      return { pass: false, reason: `Blacklisted keyword: ${kw}` };
  }
  return { pass: true };
}

async function checkTopHolders(mintAddress) {
  try {
    const res = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const supply = mintInfo.value?.data?.parsed?.info?.supply;
    if (!supply || supply === "0") return { pass: true };
    const top10 = res.value.slice(0, 10).reduce((s, a) => s + BigInt(a.amount), 0n);
    const pct = Number((top10 * 100n) / BigInt(supply));
    if (pct > CONFIG.FILTER_MAX_TOP10_HOLDER_PCT)
      return { pass: false, reason: `Top 10 holders: ${pct.toFixed(1)}% (max ${CONFIG.FILTER_MAX_TOP10_HOLDER_PCT}%)` };
    return { pass: true, top10Pct: pct };
  } catch (e) { return { pass: true }; }
}

async function checkSocials(mintAddress) {
  if (!CONFIG.FILTER_REQUIRE_SOCIAL) return { pass: true };
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
    if (!res.ok) return { pass: false, reason: "Token not found on Pump.fun" };
    const data = await res.json();
    if (!data.twitter && !data.telegram && !data.website)
      return { pass: false, reason: "No social links" };
    return { pass: true, name: data.name, symbol: data.symbol, twitter: data.twitter };
  } catch (e) { return { pass: false, reason: "Social check failed" }; }
}

async function runFilters(mintAddress, txSignature) {
  const blacklist = checkBlacklist(mintAddress);
  if (!blacklist.pass) return blacklist;

  const auth = await checkAuthorities(mintAddress);
  if (!auth.pass) return auth;

  const deployer = await checkDeployerBalance(txSignature);
  if (!deployer.pass) return deployer;

  const bonding = await checkBondingCurve(mintAddress);
  if (!bonding.pass) return bonding;

  console.log(`[FILTER] Waiting ${CONFIG.FILTER_HOLDER_WAIT_MS / 1000}s for holder data...`);
  await sleep(CONFIG.FILTER_HOLDER_WAIT_MS);

  const holders = await checkTopHolders(mintAddress);
  if (!holders.pass) return holders;

  const socials = await checkSocials(mintAddress);
  if (!socials.pass) return socials;

  return { pass: true, solBalance: bonding.solBalance, top10Pct: holders.top10Pct, name: socials.name, symbol: socials.symbol, twitter: socials.twitter };
}

// ─── BUY ─────────────────────────────────────────────────────────────────────
async function buyToken(mintAddress) {
  if (!wallet) return { success: false, error: "No wallet" };
  const bal = await connection.getBalance(wallet.publicKey);
  if (bal / LAMPORTS_PER_SOL < CONFIG.MIN_SOL_BALANCE + CONFIG.BUY_AMOUNT_SOL)
    return { success: false, error: `Low balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL` };
  if (buyCount >= CONFIG.MAX_BUY_PER_SESSION)
    return { success: false, error: `Max buys reached` };
  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const amountLamports = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
    const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountLamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`);
    const quote = await quoteRes.json();
    if (quote.error) return { success: false, error: `Quote: ${quote.error}` };
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 100000 }),
    });
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) return { success: false, error: "No swap tx" };
    const { VersionedTransaction } = require("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    buyCount++;
    return { success: true, signature: sig, tokensOut: quote.outAmount, pricePerToken: CONFIG.BUY_AMOUNT_SOL / parseFloat(quote.outAmount) };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── HANDLE NEW TOKEN ─────────────────────────────────────────────────────────
async function handleNewToken(mintAddress, txSignature) {
  if (seenMints.has(mintAddress)) return;
  seenMints.add(mintAddress);
  tokenCount++;
  console.log(`\n[TOKEN #${tokenCount}] Detected: ${mintAddress}`);

  const filterResult = await runFilters(mintAddress, txSignature);
  if (!filterResult.pass) {
    skipCount++;
    console.log(`[SKIP #${skipCount}] ❌ ${filterResult.reason}`);
    return;
  }

  console.log(`[PASS] ✅ All filters passed! ${filterResult.name || mintAddress}`);

  if (!CONFIG.AUTO_BUY_ENABLED) {
    console.log(`[PASS] AUTO_BUY_ENABLED=false — not buying`);
    console.log(`  Link: https://pump.fun/${mintAddress}`);
    return;
  }

  const buyResult = await buyToken(mintAddress);
  if (!buyResult.success) {
    console.error(`[BUY] ❌ ${buyResult.error}`);
    return;
  }

  console.log(`[BUY] ✅ TX: ${buyResult.signature}`);

  // Get buy price for position tracking
  const buyPrice = await getTokenPrice(mintAddress) || buyResult.pricePerToken;

  // Store position
  positions[mintAddress] = {
    buyPrice,
    tokensHeld: buyResult.tokensOut,
    tp1Done: false,
    tp2Done: false,
    tp3Done: false,
    stopLossDone: false,
    name: filterResult.name || "Unknown",
    symbol: filterResult.symbol || "?",
    twitter: filterResult.twitter,
    buyTime: Date.now(),
  };

  await sendTelegram(
    `🚀 <b>Bought! Monitoring for sells...</b>\n\n` +
    `🪙 <b>${filterResult.name} (${filterResult.symbol})</b>\n` +
    `📍 <code>${mintAddress}</code>\n\n` +
    `💰 SOL spent: <b>${CONFIG.BUY_AMOUNT_SOL}</b>\n` +
    `🪙 Tokens: ${buyResult.tokensOut}\n` +
    `📊 Bonding: ${filterResult.solBalance?.toFixed(2)} SOL\n` +
    `👥 Top 10: ${filterResult.top10Pct?.toFixed(1)}%\n\n` +
    `🎯 Sell targets:\n` +
    `  • TP1: ${CONFIG.TP1_MULTIPLIER}x → sell ${CONFIG.TP1_SELL_PCT}%\n` +
    `  • TP2: ${CONFIG.TP2_MULTIPLIER}x → sell ${CONFIG.TP2_SELL_PCT}%\n` +
    `  • TP3: ${CONFIG.TP3_MULTIPLIER}x → sell ${CONFIG.TP3_SELL_PCT}%\n` +
    `  • Stop: -${CONFIG.STOP_LOSS_PCT}% → sell 100%\n\n` +
    `🔗 <a href="https://pump.fun/${mintAddress}">Pump.fun</a> | ` +
    `<a href="https://solscan.io/tx/${buyResult.signature}">TX</a>`
  );

  // Start monitoring for sell triggers
  monitorPosition(mintAddress);
}

// ─── MAIN LISTENER ────────────────────────────────────────────────────────────
async function startListening() {
  console.log("[BOT] Connecting...");
  connection = new Connection(CONFIG.RPC_HTTP, { wsEndpoint: CONFIG.RPC_WSS, commitment: "confirmed" });
  const programId = new PublicKey(CONFIG.PUMP_PROGRAM_ID);
  console.log("[BOT] Subscribing to Pump.fun...");

  subscriptionId = connection.onLogs(
    programId,
    async ({ logs, signature, err }) => {
      try {
        if (err) return;
        const isCreate = logs.some(l => l.includes("Instruction: Create")) || logs.some(l => l.includes("InitializeMint"));
        if (!isCreate) return;
        const mint = await extractMintFromTx(signature);
        if (mint) await handleNewToken(mint, signature);
      } catch (e) { console.error("[LOG HANDLER]", e.message); }
    },
    "confirmed"
  );

  console.log(`[BOT] ✅ Subscribed! ID: ${subscriptionId}`);
  reconnectAttempts = 0;

  await sendTelegram(
    `🤖 <b>Crazy Boy RPC v6.0 Online!</b>\n\n` +
    `9 filters + ladder sell active:\n` +
    `🎯 TP1: ${CONFIG.TP1_MULTIPLIER}x → sell ${CONFIG.TP1_SELL_PCT}%\n` +
    `🎯 TP2: ${CONFIG.TP2_MULTIPLIER}x → sell ${CONFIG.TP2_SELL_PCT}%\n` +
    `🎯 TP3: ${CONFIG.TP3_MULTIPLIER}x → sell ${CONFIG.TP3_SELL_PCT}%\n` +
    `🛑 Stop loss: -${CONFIG.STOP_LOSS_PCT}%\n\n` +
    `Auto-buy: ${CONFIG.AUTO_BUY_ENABLED ? `✅ ${CONFIG.BUY_AMOUNT_SOL} SOL` : "❌ Off (observing)"}`
  );

  setInterval(async () => {
    try {
      const slot = await connection.getSlot();
      const openPositions = Object.keys(positions).length;
      console.log(`[HEARTBEAT] Slot: ${slot} | Detected: ${tokenCount} | Bought: ${buyCount} | Skipped: ${skipCount} | Open positions: ${openPositions}`);
    } catch (e) {
      console.error("[HEARTBEAT] Lost — reconnecting...");
      await reconnect();
    }
  }, 60000);
}

async function reconnect() {
  reconnectAttempts++;
  console.log(`[RECONNECT] Attempt ${reconnectAttempts}...`);
  if (subscriptionId !== null && connection) {
    try { await connection.removeOnLogsListener(subscriptionId); } catch (_) {}
  }
  await sleep(CONFIG.WS_RECONNECT_DELAY_MS);
  try { await startListening(); } catch (e) { await reconnect(); }
}

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  Crazy Boy RPC — Sniper Bot v6.0      ║");
  console.log("║  9 Filters + Ladder Sell              ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`RPC:        ${CONFIG.RPC_HTTP}`);
  console.log(`Auto-buy:   ${CONFIG.AUTO_BUY_ENABLED}`);
  console.log(`Buy:        ${CONFIG.BUY_AMOUNT_SOL} SOL`);
  console.log(`TP1/2/3:    ${CONFIG.TP1_MULTIPLIER}x/${CONFIG.TP2_MULTIPLIER}x/${CONFIG.TP3_MULTIPLIER}x`);
  console.log(`Stop loss:  -${CONFIG.STOP_LOSS_PCT}%`);
  console.log("");
  wallet = loadWallet();
  if (wallet) console.log(`[WALLET] ${wallet.publicKey.toString()}`);
  try { await startListening(); }
  catch (e) { console.error("[STARTUP]", e.message); await reconnect(); }
}

process.on("unhandledRejection", err => console.error("[UNHANDLED]", err?.message));
main();
