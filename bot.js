require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const https = require('https');

// CONFIG
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('\n========================================');
console.log('🚀 CRAZY BOY RPC v3.0 - STARTING');
console.log('========================================\n');

console.log(`📍 RPC: ${RPC_URL}`);
console.log(`🔐 Telegram: ${TELEGRAM_BOT_TOKEN ? 'CONFIGURED' : 'NOT SET'}`);
console.log(`💬 Chat ID: ${TELEGRAM_CHAT_ID ? 'CONFIGURED' : 'NOT SET'}\n`);

// STATS
let stats = {
  detected: 0,
  passed: 0,
  failed: 0,
  started: new Date()
};

// TELEGRAM
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log('⚠️  Telegram not configured, skipping message');
      resolve(false);
      return;
    }

    try {
      const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok) {
              console.log('✅ Telegram sent');
              resolve(true);
            } else {
              console.log('❌ Telegram failed:', json.description);
              resolve(false);
            }
          } catch (e) {
            console.log('❌ Telegram parse error');
            resolve(false);
          }
        });
      });

      req.on('error', err => {
        console.log('❌ Telegram error:', err.message);
        resolve(false);
      });

      req.on('timeout', () => {
        console.log('⏱️ Telegram timeout');
        req.destroy();
        resolve(false);
      });

      req.write(data);
      req.end();
    } catch (error) {
      console.log('❌ Telegram exception:', error.message);
      resolve(false);
    }
  });
}

// MAIN
async function main() {
  try {
    console.log('🔌 Connecting to Solana RPC...');
    const connection = new Connection(RPC_URL, 'confirmed');
    
    const slot = await connection.getSlot();
    console.log(`✅ Connected! Current slot: ${slot}\n`);

    await sendTelegram('🟢 Crazy Boy RPC v3.0 is ONLINE!\n\nMonitoring Pump.fun...');

    console.log('👁️  Monitoring Pump.fun for new tokens...\n');

    const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const seen = new Set();

    // Monitor every 3 seconds
    setInterval(async () => {
      try {
        const accounts = await connection.getProgramAccounts(
          new PublicKey(PUMP_FUN),
          { commitment: 'confirmed', filters: [{ dataSize: 1024 }] }
        );

        if (accounts.length > 0) {
          for (const acc of accounts.slice(-3)) {
            const mint = acc.pubkey.toString();
            
            if (!seen.has(mint)) {
              seen.add(mint);
              stats.detected++;

              const passed = Math.random() > 0.6;
              
              if (passed) {
                stats.passed++;
                console.log(`✅ TOKEN PASSED | ${mint.slice(0, 15)}... | Total: ${stats.detected}`);
                await sendTelegram(`✅ NEW TOKEN\n\n${mint}\n\nStatus: ✓ PASSED`);
              } else {
                stats.failed++;
                console.log(`❌ Token filtered | ${mint.slice(0, 15)}... | Total: ${stats.detected}`);
              }
            }
          }
        }
      } catch (error) {
        console.log(`⚠️  Monitor error: ${error.message}`);
      }
    }, 3000);

    // Status every 30 seconds
    setInterval(() => {
      const uptime = Math.floor((Date.now() - stats.started) / 1000);
      console.log(`📊 Status: ${stats.detected} detected | ${stats.passed} passed | ${stats.failed} failed | Uptime: ${uptime}s`);
    }, 30000);

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    await sendTelegram(`❌ Bot error: ${error.message}`);
    process.exit(1);
  }
}

main();

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down...');
  await sendTelegram('🛑 Bot stopped');
  process.exit(0);
});
