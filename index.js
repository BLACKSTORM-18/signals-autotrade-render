// _TheChartist_ & _TheExecutor_ v80 (Server Edition ☁️)
// Environment: Node.js (Render/Railway/VPS)
// Features: 24/7 Trading, Full Dashboard, No Cloudflare Limits.

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

// ================= CONFIGURATION (ENV VARS) =================
// You will set these in the Render/Railway Dashboard
const CONFIG = {
    API_KEY: process.env.BLOFIN_API_KEY,
    API_SECRET: process.env.BLOFIN_API_SECRET,
    PASSPHRASE: process.env.BLOFIN_PASSPHRASE,
    TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TG_CHAT: process.env.TELEGRAM_CHAT_ID,
    REDIS_URL: process.env.UPSTASH_REDIS_REST_URL,
    REDIS_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    COST_PER_TRADE: parseFloat(process.env.COST_PER_TRADE || "1"),
    MIN_VOLUME: 500000,
    LEVERAGE: 20,
    MAX_ACTIVE: 30,
    PORT: process.env.PORT || 3000
};

// ================= STATE =================
let STATE = {
    active: [],
    history: [],
    lastRun: 0,
    wallet: 0,
    logs: []
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
                // Full Headers to look legit
                "User-Agent": "Mozilla/5.0 (Node.js/18) BlofinBot/1.0",
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

// ================= TA ENGINE =================
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

// ================= LOGIC: SCANNER =================
async function runScanner() {
    // 1. Fetch Tickers
    const tickers = await blofinRequest("GET", "/market/tickers");
    if(!tickers) return;
    
    // 2. Filter & Sort
    const candidates = tickers
        .filter(t => t.instId.endsWith("-USDT"))
        .filter(t => (parseFloat(t.vol24h)*parseFloat(t.last)) > CONFIG.MIN_VOLUME)
        .map(t => ({ ...t, change: Math.abs((t.last - t.open24h)/t.open24h) }))
        .sort((a,b) => b.change - a.change)
        .slice(0, 80); // Top 80

    // 3. Scan Batch (15 random)
    const batch = candidates.sort(() => 0.5 - Math.random()).slice(0, 15);

    for(const coin of batch) {
        if(STATE.active.length >= CONFIG.MAX_ACTIVE) break;
        if(STATE.active.find(a => a.symbol === coin.instId)) continue;

        // Fetch Candles
        const candlesRaw = await blofinRequest("GET", "/market/candles", { instId: coin.instId, bar: "5m", limit: 60 });
        if(!candlesRaw || candlesRaw.length < 50) continue;
        
        // Parse: Blofin [ts, o, h, l, c, v] -> Sort Oldest First
        const candles = candlesRaw.map(c => parseFloat(c[4])).reverse(); 
        const current = candles[candles.length-1];

        // Analysis (Golden Fan)
        const ema20 = calcEMA(candles, 20).pop();
        const ema50 = calcEMA(candles, 50).pop();
        const rsi = calcRSI(candles, 7);

        let signal = null;
        if(current > ema20 && ema20 > ema50 && rsi < 55) signal = "LONG";
        if(current < ema20 && ema20 < ema50 && rsi > 45) signal = "SHORT";

        if(signal) {
            // Risk Calc
            const range = candles.slice(-14);
            const atr = (Math.max(...range) - Math.min(...range)) / 14; 
            const dir = signal === "LONG" ? 1 : -1;
            const sl = current - (dir * atr * 0.75);
            const tps = [0.6, 1.2, 2.0, 3.5].map(m => current + (dir * atr * m));
            
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

// ================= LOGIC: EXECUTOR =================
async function runExecutor() {
    // 1. Balance Check
    const bal = await blofinRequest("GET", "/account/balance");
    if(bal) STATE.wallet = parseFloat(bal.find(b=>b.currency==="USDT")?.available || 0);

    // 2. Active Positions
    const positions = await blofinRequest("GET", "/account/positions", { instType: "SWAP" }) || [];
    const pendingOrders = await blofinRequest("GET", "/trade/orders-pending", { instType: "SWAP" }) || [];

    for(let i = STATE.active.length - 1; i >= 0; i--) {
        let s = STATE.active[i];
        
        // Match Position
        const pos = positions.find(p => p.instId === s.symbol && parseFloat(p.positions) !== 0);
        const entryOrder = pendingOrders.find(o => o.instId === s.symbol && o.orderType === "limit");

        // --- A. ENTRY LOGIC ---
        if (!pos && !entryOrder) {
            if (STATE.wallet < CONFIG.COST_PER_TRADE) continue;

            const ticker = await blofinRequest("GET", "/market/tickers", { instId: s.symbol });
            if (!ticker) continue;
            const curPrice = parseFloat(ticker[0].last);
            
            // Smart Entry
            const isLong = s.type === "LONG";
            let orderType = "market";
            let priceParam = {};
            if (isLong && curPrice > s.entry * 1.002) { orderType = "limit"; priceParam = { price: String(s.entry) }; }
            else if (!isLong && curPrice < s.entry * 0.998) { orderType = "limit"; priceParam = { price: String(s.entry) }; }

            // Size
            const size = (CONFIG.COST_PER_TRADE * CONFIG.LEVERAGE) / (orderType==="limit" ? s.entry : curPrice);
            
            // Execute
            await blofinRequest("POST", "/account/set-leverage", {}, { instId: s.symbol, leverage: String(CONFIG.LEVERAGE), marginMode: "isolated" });
            const order = await blofinRequest("POST", "/trade/order", {}, {
                instId: s.symbol, marginMode: "isolated", side: isLong?"buy":"sell",
                orderType, size: String(size.toFixed(4)), ...priceParam
            });

            if(order) {
                // Hard Orders (SL/TP)
                await placeAlgo("sl", s.symbol, s.sl, size.toFixed(4), isLong);
                const tp1Size = (size/2).toFixed(4);
                if(parseFloat(tp1Size) > 0) await placeAlgo("tp", s.symbol, s.tps[0], tp1Size, isLong);
                // (Optional) Hard TP4
                const tp4Size = (size - parseFloat(tp1Size)).toFixed(4);
                if(parseFloat(tp4Size) > 0) await placeAlgo("tp", s.symbol, s.tps[3], tp4Size, isLong);
            }
        }

        // --- B. TRAILING LOGIC ---
        if (pos) {
            const currentSize = parseFloat(pos.positions);
            const isLong = pos.positionSide === "long";
            
            // Calc Current PnL
            const markPrice = parseFloat(pos.markPrice);
            s.pnl = (((markPrice - s.entry)/s.entry) * (isLong?1:-1) * 100 * CONFIG.LEVERAGE).toFixed(2);

            // Check TPs (Soft Check for Stats)
            for(let j=0; j<4; j++) {
                const hit = isLong ? markPrice >= s.tps[j] : markPrice <= s.tps[j];
                if(hit && !s.hits.includes(j+1)) {
                    s.hits.push(j+1);
                    // If TP1 hit -> Trail SL
                    if(j===0) {
                        const newSL = isLong ? Math.max(s.sl, s.entry) : Math.min(s.sl, s.entry);
                        s.sl = newSL;
                        // Update Algo Order Here (Fetch, Cancel, Replace) - Simplified for brevity
                        updateSLOnChain(s.symbol, newSL, currentSize, isLong);
                    }
                }
            }
        }
        
        // --- C. CLEANUP ---
        // If trade closed on exchange (no pos, no order), move to history
        if (!pos && !entryOrder && (Date.now() - s.timestamp > 60000)) {
            // Check if it was closed or just never opened?
            // For now, assume closed if it's old and gone.
            STATE.history.unshift({...s, closedTime: Date.now()});
            STATE.active.splice(i, 1);
            if(STATE.history.length > 300) STATE.history.pop();
            saveState();
        }
    }
}

// --- ALGO HELPERS ---
async function placeAlgo(type, symbol, price, size, isLong) {
    return await blofinRequest("POST", "/trade/order-algo", {}, {
        instId: symbol, marginMode: "isolated", side: isLong?"sell":"buy",
        algoType: type, triggerPrice: String(price), orderPrice: "-1", size: String(size)
    });
}

async function updateSLOnChain(symbol, price, size, isLong) {
    // 1. Get Pending Algos
    const algos = await blofinRequest("GET", "/trade/orders-algo-pending", { instId: symbol, instType: "SWAP" });
    if(algos) {
        const slOrder = algos.find(a => a.algoType === "sl");
        if(slOrder) {
            // 2. Cancel Old
            await blofinRequest("POST", "/trade/cancel-algo-order", {}, { instId: symbol, algoId: slOrder.algoId });
        }
    }
    // 3. Place New
    await placeAlgo("sl", symbol, price, size, isLong);
}

// ================= REDIS SYNC =================
async function syncRedis() {
    if(!CONFIG.REDIS_URL) return;
    await upstash("SET", "bot_state", JSON.stringify(STATE));
}

async function loadRedis() {
    if(!CONFIG.REDIS_URL) return;
    const data = await upstash("GET", "bot_state");
    if(data) STATE = JSON.parse(data);
}

// ================= SERVER (Dashboard) =================
const app = express();

app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TheChartist Cloud</title>
        <style>
            body { background: #0b0e11; color: #e1e1e1; font-family: 'Inter', sans-serif; padding: 20px; text-align: center; }
            .card { background: #151a21; border: 1px solid #2a2e35; padding: 15px; margin: 10px auto; max-width: 400px; border-radius: 12px; text-align: left; }
            .green { color: #00ce7c; } .red { color: #ff4d4d; }
            h1 { font-style: italic; background: linear-gradient(135deg, #fff, #999); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        </style>
    </head>
    <body>
        <h1>_TheChartist_ Cloud ☁️</h1>
        <p>Wallet: $${STATE.wallet.toFixed(2)} | Active: ${STATE.active.length}</p>
        <div id="list">
            ${STATE.active.map(s => `
                <div class="card">
                    <div style="display:flex;justify-content:space-between">
                        <b>${s.symbol}</b>
                        <span class="${s.type=='LONG'?'green':'red'}">${s.type}</span>
                    </div>
                    <div>Entry: ${s.entry} | SL: ${s.sl.toFixed(4)}</div>
                    <div style="margin-top:5px;font-size:0.9em;color:#888">PnL: ${s.pnl}%</div>
                </div>
            `).join('')}
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// ================= BOOTSTRAP =================
(async () => {
    console.log("🚀 Starting Cloud Bot...");
    await loadRedis();
    
    // Start Server
    app.listen(CONFIG.PORT, () => {
        console.log(`Server running on port ${CONFIG.PORT}`);
    });

    // Start Loops
    setInterval(runScanner, 60000); // 1 min Scanner
    setTimeout(() => setInterval(runExecutor, 60000), 5000); // Offset Executor
})();

