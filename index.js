// _TheChartist_ & _TheExecutor_ v81 (The Monolith 🗿)
// Environment: Node.js (Render/Railway/VPS)
// Features: Full Scanner + Hard Mode Auto-Trading + Premium Dashboard
// Logic: Golden Fan Filter + Smart Entry + Hard Algo Orders

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

// ================= CONFIGURATION =================
const CONFIG = {
    // API KEYS (Set these in Render Environment Variables)
    API_KEY: process.env.BLOFIN_API_KEY,
    API_SECRET: process.env.BLOFIN_API_SECRET,
    PASSPHRASE: process.env.BLOFIN_PASSPHRASE,
    
    // INTEGRATIONS
    TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TG_CHAT: process.env.TELEGRAM_CHAT_ID,
    REDIS_URL: process.env.UPSTASH_REDIS_REST_URL,
    REDIS_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    
    // TRADING SETTINGS
    COST_PER_TRADE: parseFloat(process.env.COST_PER_TRADE || "1"),
    MIN_VOLUME: 500000,
    LEVERAGE: 20,
    MAX_ACTIVE: 30,
    
    // RISK MANAGEMENT
    TP_MULTS: [0.6, 1.2, 2.0, 3.5],
    SL_MULT: 0.75,
    
    PORT: process.env.PORT || 3000
};

// ================= STATE MEMORY =================
let STATE = {
    active: [],
    history: [],
    lastRun: 0,
    wallet: 0,
    logs: [] // Store recent logs for dashboard
};

// ================= API HELPERS =================
async function blofinRequest(method, endpoint, params = {}, body = null) {
    const host = "https://openapi.blofin.com";
    let path = `/api/v1${endpoint}`;
    let query = new URLSearchParams(params).toString();
    if (method === "GET" && query) path += `?${query}`;
    
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyStr = body ? JSON.stringify(body) : "";
    
    const preHash = path + method + timestamp + nonce + bodyStr;
    const sign = crypto.createHmac('sha256', CONFIG.API_SECRET).update(preHash).digest('base64');
    
    try {
        const res = await fetch(`${host}${path}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                "ACCESS-KEY": CONFIG.API_KEY,
                "ACCESS-PASSPHRASE": CONFIG.PASSPHRASE,
                "ACCESS-TIMESTAMP": timestamp,
                "ACCESS-NONCE": nonce,
                "ACCESS-SIGN": sign,
                "User-Agent": "Mozilla/5.0 (Node.js) BlofinBot/1.0",
                "Accept": "application/json"
            },
            body: body ? bodyStr : null
        });
        const json = await res.json();
        return json.code === "0" ? json.data : null;
    } catch(e) { console.error(`API Error ${endpoint}:`, e.message); return null; }
}

async function sendTelegram(msg) {
    if(!CONFIG.TG_TOKEN) return;
    try {
        await fetch(`https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CONFIG.TG_CHAT, parse_mode: "HTML", text: msg })
        });
    } catch(e) {}
}

async function upstash(command, ...args) {
    if(!CONFIG.REDIS_URL) return null;
    try {
        const res = await fetch(`${CONFIG.REDIS_URL}`, {
            method: "POST", headers: { "Authorization": `Bearer ${CONFIG.REDIS_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify([command, ...args])
        });
        return (await res.json()).result;
    } catch(e) { return null; }
}

// ================= MATH & TA =================
function calcEMA(data, period) {
    if (data.length < period) return [];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const res = [ema];
    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * k + ema;
        res.push(ema);
    }
    return res;
}

function calcRSI(data, period = 14) {
    if (data.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = data[i] - data[i-1];
        if(d>0) gains+=d; else losses-=Math.abs(d);
    }
    let avgU = gains/period, avgD = losses/period;
    let rsi = 100 - (100/(1+avgU/avgD));
    for (let i = period+1; i < data.length; i++) {
        const d = data[i] - data[i-1];
        avgU = (avgU*(period-1) + (d>0?d:0))/period;
        avgD = (avgD*(period-1) + (d<0?-d:0))/period;
        rsi = 100 - (100/(1+avgU/avgD));
    }
    return rsi;
}

// ================= SCANNER LOGIC =================
async function runScanner() {
    // 1. Fetch
    const tickers = await blofinRequest("GET", "/market/tickers");
    if(!tickers) return;
    
    // 2. Filter (Shotgun)
    const candidates = tickers
        .filter(t => t.instId.endsWith("-USDT"))
        .filter(t => (parseFloat(t.vol24h)*parseFloat(t.last)) > CONFIG.MIN_VOLUME)
        .map(t => ({ ...t, change: Math.abs((t.last - t.open24h)/t.open24h) }))
        .sort((a,b) => b.change - a.change)
        .slice(0, 80);

    const batch = candidates.sort(() => 0.5 - Math.random()).slice(0, 15);

    for(const coin of batch) {
        if(STATE.active.length >= CONFIG.MAX_ACTIVE) break;
        if(STATE.active.find(a => a.symbol === coin.instId)) continue;

        const candlesRaw = await blofinRequest("GET", "/market/candles", { instId: coin.instId, bar: "5m", limit: 60 });
        if(!candlesRaw || candlesRaw.length < 50) continue;
        
        // [ts, o, h, l, c, v]
        const klines = candlesRaw.map(k => [parseInt(k[0]), parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])]).sort((a, b) => a[0] - b[0]);
        const closes = klines.map(k => k[4]);
        const current = closes[closes.length-1];

        // Golden Fan
        const ema20 = calcEMA(closes, 20).pop();
        const ema50 = calcEMA(closes, 50).pop();
        const rsi = calcRSI(closes, 7);

        let signal = null;
        // Logic: Golden Fan + RSI Pullback
        if(current > ema20 && ema20 > ema50 && rsi < 55) signal = "LONG";
        if(current < ema20 && ema20 < ema50 && rsi > 45) signal = "SHORT";

        if(signal) {
            const range = klines.slice(-14);
            // Simple ATR approx (High - Low avg)
            const atr = range.reduce((a,b) => a + (b[2]-b[3]), 0) / 14;
            const dir = signal === "LONG" ? 1 : -1;
            const sl = current - (dir * atr * CONFIG.SL_MULT);
            const tps = CONFIG.TP_MULTS.map(m => current + (dir * atr * m));
            
            const trade = {
                symbol: coin.instId, type: signal, entry: current, sl, tps,
                leverage: CONFIG.LEVERAGE, hits: [], pnl: 0, timestamp: Date.now()
            };
            
            STATE.active.push(trade);
            await sendTelegram(`🦅 <b>${signal} ${coin.instId}</b>\nEntry: ${current}\nSL: ${sl.toFixed(4)}`);
            await syncRedis();
        }
    }
}

// ================= EXECUTOR LOGIC =================
async function placeAlgo(type, symbol, price, size, isLong) {
    return await blofinRequest("POST", "/trade/order-algo", {}, {
        instId: symbol, marginMode: "isolated", side: isLong?"sell":"buy",
        algoType: type, triggerPrice: String(price), orderPrice: "-1", size: String(size)
    });
}

async function runExecutor() {
    // 1. Data Sync
    const bal = await blofinRequest("GET", "/account/balance");
    if(bal) STATE.wallet = parseFloat(bal.find(b=>b.currency==="USDT")?.available || 0);

    const positions = await blofinRequest("GET", "/account/positions", { instType: "SWAP" }) || [];
    const pendingOrders = await blofinRequest("GET", "/trade/orders-pending", { instType: "SWAP" }) || [];

    for(let i = STATE.active.length - 1; i >= 0; i--) {
        let s = STATE.active[i];
        const pos = positions.find(p => p.instId === s.symbol && parseFloat(p.positions) !== 0);
        const entryOrder = pendingOrders.find(o => o.instId === s.symbol && o.orderType === "limit");

        // --- A. ENTRY (Smart Limit/Market) ---
        if (!pos && !entryOrder) {
            if (STATE.wallet < CONFIG.COST_PER_TRADE) continue;

            const ticker = await blofinRequest("GET", "/market/tickers", { instId: s.symbol });
            if (!ticker) continue;
            const curPrice = parseFloat(ticker[0].last);
            
            const isLong = s.type === "LONG";
            let orderType = "market", priceParam = {};
            if (isLong && curPrice > s.entry * 1.002) { orderType = "limit"; priceParam = { price: String(s.entry) }; }
            else if (!isLong && curPrice < s.entry * 0.998) { orderType = "limit"; priceParam = { price: String(s.entry) }; }

            const size = (CONFIG.COST_PER_TRADE * CONFIG.LEVERAGE) / (orderType==="limit" ? s.entry : curPrice);
            
            await blofinRequest("POST", "/account/set-leverage", {}, { instId: s.symbol, leverage: String(CONFIG.LEVERAGE), marginMode: "isolated" });
            const order = await blofinRequest("POST", "/trade/order", {}, {
                instId: s.symbol, marginMode: "isolated", side: isLong?"buy":"sell",
                orderType, size: String(size.toFixed(4)), ...priceParam
            });

            if(order) {
                // HARD ORDERS IMMEDIATELY
                await placeAlgo("sl", s.symbol, s.sl, size.toFixed(4), isLong);
                const tp1Size = (size/2).toFixed(4);
                if(parseFloat(tp1Size) > 0) await placeAlgo("tp", s.symbol, s.tps[0], tp1Size, isLong);
                const tp4Size = (size - parseFloat(tp1Size)).toFixed(4);
                if(parseFloat(tp4Size) > 0) await placeAlgo("tp", s.symbol, s.tps[3], tp4Size, isLong);
            }
        }

        // --- B. TRAILING (Price & Stats Sync) ---
        if (pos) {
            const markPrice = parseFloat(pos.markPrice);
            const isLong = pos.positionSide === "long";
            // Calc PnL for UI
            s.pnl = (((markPrice - s.entry)/s.entry) * (isLong?1:-1) * 100 * CONFIG.LEVERAGE).toFixed(2);

            // Soft check for Dashboard "Hits" UI (Actual execution is Hard Algo)
            for(let j=0; j<4; j++) {
                const hit = isLong ? markPrice >= s.tps[j] : markPrice <= s.tps[j];
                if(hit && !s.hits.includes(j+1)) s.hits.push(j+1);
            }

            // Sync SL (The Auditor)
            // Ideally check pending algos here and update if s.sl changed by logic
            // Skipping complex audit in v1 Monolith to ensure stability first
        }

        // --- C. CLEANUP (Ghostbuster) ---
        if (!pos && !entryOrder && (Date.now() - s.timestamp > 120000)) {
            // Closed Trade
            STATE.history.unshift({...s, closedTime: Date.now()});
            STATE.active.splice(i, 1);
            if(STATE.history.length > 300) STATE.history.pop();
            await syncRedis();
        }
    }
}

// ================= STORAGE =================
async function syncRedis() {
    if(!CONFIG.REDIS_URL) return;
    await upstash("SET", "bot_state", JSON.stringify(STATE));
}

async function loadRedis() {
    if(!CONFIG.REDIS_URL) return;
    const data = await upstash("GET", "bot_state");
    if(data) STATE = JSON.parse(data);
}

// ================= WEB SERVER (FULL UI) =================
const app = express();

app.get('/', (req, res) => {
    // Stats Calc
    const wins = STATE.history.filter(h => parseFloat(h.pnl) > 0).length;
    const total = STATE.history.length;
    const wr = total ? ((wins/total)*100).toFixed(1) : 0;
    
    // HTML Template
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TheChartist Monolith</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #0b0e11; --card: #151a21; --text: #e1e1e1; --green: #00ce7c; --red: #ff4d4d; --gray: #848e9c; }
            body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; margin: 0; padding: 16px; }
            .brand { text-align: center; font-weight: 800; font-size: 1.5rem; background: linear-gradient(135deg, #fff, #888); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .stats-bar { display: flex; gap: 10px; overflow-x: auto; padding: 10px 0; }
            .stat-card { background: var(--card); border: 1px solid #333; padding: 10px; border-radius: 8px; min-width: 100px; text-align: center; }
            .big-num { font-size: 1.2rem; font-weight: 800; color: var(--green); }
            .card { background: var(--card); border: 1px solid #333; padding: 15px; margin: 10px 0; border-radius: 12px; }
            .row { display: flex; justify-content: space-between; align-items: center; }
            .badge { padding: 3px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; }
            .long { background: rgba(0,206,124,0.15); color: var(--green); }
            .short { background: rgba(255,77,77,0.15); color: var(--red); }
            .progress { height: 4px; background: #333; margin-top: 10px; border-radius: 2px; position: relative; }
            .bar { height: 100%; background: var(--green); width: 0%; transition: 0.5s; }
        </style>
    </head>
    <body>
        <div class="brand">_TheChartist_ Monolith</div>
        <div style="text-align:center;font-size:0.8rem;color:#666;margin-bottom:20px">Blofin Native • Server Edition</div>
        
        <div class="stats-bar">
            <div class="stat-card">
                <div style="font-size:0.7rem;color:#888">WALLET</div>
                <div class="big-num">$${STATE.wallet.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div style="font-size:0.7rem;color:#888">WIN RATE</div>
                <div class="big-num" style="color:${wr>=50?'var(--green)':'var(--red)'}">${wr}%</div>
            </div>
            <div class="stat-card">
                <div style="font-size:0.7rem;color:#888">ACTIVE</div>
                <div class="big-num" style="color:#fff">${STATE.active.length}</div>
            </div>
        </div>

        <h3>Active Signals</h3>
        ${STATE.active.map(s => {
            const isLong = s.type === "LONG";
            const pnlColor = parseFloat(s.pnl) >= 0 ? 'var(--green)' : 'var(--red)';
            return `
            <div class="card">
                <div class="row">
                    <b>${s.symbol}</b>
                    <span class="badge ${isLong?'long':'short'}">${s.type} ${CONFIG.LEVERAGE}x</span>
                </div>
                <div class="row" style="margin-top:10px;font-size:0.9rem">
                    <span>Entry: ${s.entry}</span>
                    <span>SL: ${s.sl.toFixed(4)}</span>
                </div>
                <div class="row" style="margin-top:5px">
                    <span style="font-size:0.8rem;color:#666">${s.hits.length} Targets Hit</span>
                    <b style="color:${pnlColor}">${s.pnl}%</b>
                </div>
                <div class="progress">
                    <div class="bar" style="width: ${Math.min(Math.abs(s.pnl), 100)}%; background:${pnlColor}"></div>
                </div>
            </div>`;
        }).join('') || '<div style="text-align:center;color:#666;padding:20px">Scanning...</div>'}

        <h3>Recent History</h3>
        ${STATE.history.slice(0, 10).map(s => {
            const pnlColor = parseFloat(s.pnl) >= 0 ? 'var(--green)' : 'var(--red)';
            return `
            <div class="card" style="opacity:0.7">
                <div class="row">
                    <b>${s.symbol}</b>
                    <b style="color:${pnlColor}">${s.pnl}%</b>
                </div>
                <div style="font-size:0.8rem;color:#666;margin-top:5px">Closed: ${new Date(s.closedTime).toLocaleTimeString()}</div>
            </div>`;
        }).join('')}
    </body>
    </html>
    `;
    res.send(html);
});

// ================= BOOTSTRAP =================
(async () => {
    console.log("🚀 Powering up Monolith...");
    await loadRedis();
    
    app.listen(CONFIG.PORT, () => {
        console.log(`✅ Server online at port ${CONFIG.PORT}`);
    });

    // Loops
    setInterval(runScanner, 60000); // 1m Scanner
    setTimeout(() => setInterval(runExecutor, 60000), 5000); // 1m Executor (Offset)
})();


