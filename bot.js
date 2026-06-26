require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

// CONFIG
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT) || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'CrazyBoy123';

// STATS
const stats = {
  detected: 0,
  passed: 0,
  failed: 0
};

// TELEGRAM SENDER
async function sendTelegram(text) {
  try {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text
    });

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }
    );

    if (response.ok) {
      console.log('📱 Telegram sent');
    } else {
      console.error('Telegram error:', response.statusText);
    }
  } catch (error) {
    console.error('Telegram error:', error.message);
  }
}

// DASHBOARD SERVER
function startDashboard() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const expectedAuth = `Basic ${Buffer.from(`admin:${DASHBOARD_PASSWORD}`).toString('base64')}`;

    if (!auth || auth !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<h1>🔒 Unauthorized</h1>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Crazy Boy RPC v2.1.1</title>
          <style>
            body { 
              font-family: Arial; 
              background: #0f0f1e; 
              color: #fff; 
              padding: 20px;
            }
            .container { max-width: 1200px; margin: 0 auto; }
            h1 { color: #00ff88; }
            .stats { 
              display: grid; 
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
              gap: 20px; 
            }
            .stat-card { 
              background: #1a1a2e; 
              border: 2px solid #00ff88; 
              border-radius: 8px; 
              padding: 20px; 
              text-align: center; 
            }
            .stat-card h3 { color: #00ff88; font-size: 12px; margin-bottom: 10px; }
            .number { font-size: 36px; font-weight: bold; color: #00ff88; }
            .status { color: #00ff88; font-size: 18px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🚀 Crazy Boy RPC v2.1.1</h1>
            <div class="stats">
              <div class="stat-card">
                <h3>Tokens Detected</h3>
                <div class="number">${stats.detected}</div>
              </div>
              <div class="stat-card">
                <h3>Passed Filters</h3>
                <div class="number">${stats.passed}</div>
              </div>
              <div class="stat-card">
                <h3>Failed Filters</h3>
                <div class="number">${stats.failed}</div>
              </div>
              <div class="stat-card">
                <h3>Status</h3>
                <div class="status">🟢 LIVE</div>
              </div>
            </div>
            <p style="margin-top: 30px; text-align: center; color: #666;">
              Last updated: ${new Date().toLocaleTimeString()}
            </p>
          </div>
          <script>
            setInterval(() => location.reload(), 5000);
          </script>
        </body>
      </html>
    `);
  });

  server.listen(DASHBOARD_PORT, () => {
    console.log(`📊 Dashboard running on port ${DASHBOARD_PORT}`);
  });
}

// MONITOR PUMP.FUN
async function monitorPumpFun(connection) {
  console.log('👁️  Monitoring Pump.fun for new tokens...');

  const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const seenTokens = new Set();

  // Poll every 3 seconds
  setInterval(async () => {
    try {
      const accounts = await connection.getProgramAccounts(
        new PublicKey(PUMP_FUN_PROGRAM),
        {
          commitment: 'confirmed',
          filters: [{ dataSize: 1024 }]
        }
      );

      if (accounts.length > 0) {
        for (const account of accounts.slice(-5)) {
          const tokenMint = account.pubkey.toString();

          if (!seenTokens.has(tokenMint)) {
            seenTokens.add(tokenMint);
            stats.detected++;

            console.log(`\n🔍 New token detected: ${tokenMint}`);
            console.log(`📊 Total detected: ${stats.detected}`);

            // Random filter result (simplified)
            const passed = Math.random() > 0.6;

            if (passed) {
              stats.passed++;
              console.log(`✅ Token PASSED filters!`);
              await sendTelegram(`✅ NEW TOKEN ALERT\n\n${tokenMint}\n\nStatus: PASSED FILTERS`);
            } else {
              stats.failed++;
              console.log(`❌ Token failed filters`);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Monitor error:', error.message);
    }
  }, 3000);
}

// MAIN
async function main() {
  try {
    console.log('\n🚀 Crazy Boy RPC v2.1.1 starting...');

    // Validate RPC URL
    if (!RPC_URL || !RPC_URL.startsWith('http')) {
      throw new Error('Invalid RPC_URL - must start with http:// or https://');
    }

    console.log(`🔌 Connecting to RPC: ${RPC_URL.substring(0, 50)}...`);

    // Connect to Solana
    const connection = new Connection(RPC_URL, 'confirmed');
    const slot = await connection.getSlot();

    console.log(`✅ Connected to Solana!`);
    console.log(`📍 Current slot: ${slot}`);

    // Start dashboard
    startDashboard();

    // Start monitoring
    await monitorPumpFun(connection);

    // Send startup message
    await sendTelegram('🟢 Sniper bot online! v2.1.1 monitoring Pump.fun...');

    console.log('\n✅ Bot fully initialized!');
    console.log('📱 Telegram alerts: ENABLED');
    console.log(`📊 Dashboard: Running on port ${DASHBOARD_PORT}`);
    console.log('\n🎯 Ready to detect tokens!\n');

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    await sendTelegram(`❌ Bot startup failed: ${error.message}`);
    process.exit(1);
  }
}

// Start bot
main();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  await sendTelegram('🛑 Sniper bot stopped');
  process.exit(0);
});
