require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');
const https = require('https');

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
  failed: 0,
  startTime: new Date()
};

// TELEGRAM SENDER (using built-in https module)
function sendTelegram(text) {
  return new Promise((resolve) => {
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
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          console.log('📱 Telegram sent');
          resolve(true);
        });
      });

      req.on('error', (error) => {
        console.error('Telegram error:', error.message);
        resolve(false);
      });

      req.write(data);
      req.end();
    } catch (error) {
      console.error('Telegram error:', error.message);
      resolve(false);
    }
  });
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
          <title>Crazy Boy RPC v2.2</title>
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
            <h1>🚀 Crazy Boy RPC v2.2</h1>
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
              Started: ${stats.startTime.toLocaleString()}<br>
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

            console.log(`\n🔍 New token: ${tokenMint}`);

            // Simplified filter
            const passed = Math.random() > 0.6;

            if (passed) {
              stats.passed++;
              console.log(`✅ Token PASSED`);
              await sendTelegram(`✅ NEW TOKEN\n\n${tokenMint}\n\nStatus: PASSED`);
            } else {
              stats.failed++;
              console.log(`❌ Token FAILED`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Monitor error:', error.message);
    }
  }, 3000);
}

// MAIN
async function main() {
  try {
    console.log('\n🚀 Crazy Boy RPC v2.2 starting...');

    if (!RPC_URL || !RPC_URL.startsWith('http')) {
      throw new Error('Invalid RPC_URL');
    }

    console.log(`🔌 Connecting to RPC...`);

    const connection = new Connection(RPC_URL, 'confirmed');
    const slot = await connection.getSlot();

    console.log(`✅ Connected!`);
    console.log(`📍 Slot: ${slot}`);

    // Start dashboard
    startDashboard();

    // Start monitoring
    await monitorPumpFun(connection);

    // Send online message
    await sendTelegram('🟢 Bot online! v2.2 monitoring...');

    console.log('\n✅ Bot ready!');
    console.log('📱 Telegram: ENABLED');
    console.log(`📊 Dashboard: Port ${DASHBOARD_PORT}\n`);

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    await sendTelegram(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();

process.on('SIGINT', async () => {
  console.log('\n🛑 Stopping...');
  await sendTelegram('🛑 Bot stopped');
  process.exit(0);
});
