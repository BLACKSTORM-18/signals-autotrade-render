// _TheChartist_ v137 (The Eternal)
// Architecture: Server-First Boot (Prevents "Process Exited" crash)
// Safety: Lazy Redis Connection + Infinite Event Loop
// Logic: 15m Adaptive Hybrid (Scoring System)
// Watchlist: 200 High-Vol Assets

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const WebSocket = require('ws');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const cron = require('node-cron');

// --- 1. CRASH PROOFING ---
process.on('uncaughtException', e => console.error('🔥 UNCAUGHT:', e.message));
process.on('unhandledRejection', e => console.error('🔥 REJECTED:', e));

// --- 2. CONFIG ---
const PORT = process.env.PORT || 8080;
const BINANCE_WS = "wss://fstream.binance.com/ws"; 
const BINGX_URL = "https://open-api.bingx.com";
const GLOBAL_MIN_VOLUME = 10000000; 
const WATCHLIST_SIZE = 200; 
const MAX_ACTIVE_SIGNALS = 30; 
const TP_MULTS = [1.2, 2.5, 5.0, 10.0]; 
const SL_MULT = 1.0; 
const STALE_TRADE_HOURS = 24; 
const COST_PER_TRADE = parseFloat(process.env.COST_PER_TRADE || 10);
const TIMEFRAME = "15m";
const MIN_SCORE = 70; 

const state = {
    candles: {}, activeSignals: [], history: [], tickers: [],
    fundingRates: {}, btcChange: 0,
    ws: null, wsHeartbeat: null, cexOnline: false, dbOnline: false, lastRun: Date.now()
};

// --- 3. SERVER (STARTS IMMEDIATELY) ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send(renderHTML()));
app.get('/api/data', (req, res) => {
    const prettyActive = state.activeSignals.map(s => ({...s, symbol: s.symbol.replace("USDT", "-USDT")}));
    const prettyHistory = state.history.map(s => ({...s, symbol: s.symbol.replace("USDT", "-USDT")}));
    res.json({ active: prettyActive, history: prettyHistory, lastRun: state.lastRun, cexOnline: state.cexOnline, dbOnline: state.dbOnline });
});
app.post('/api/reset', async (req, res) => {
    state.history = []; state.activeSignals = []; await saveState(); res.json({ok:true});
});

// Bind to port immediately to satisfy Zeabur health check
const server = app.listen(PORT, () => {
    console.log(`🚀 v137 ETERNAL running on port ${PORT}`);
    // Delay logic start to ensure environment is stable
    setTimeout(bootSystem, 3000);
});

// --- 4. INFINITE LOOP (Prevents Process Exit) ---
setInterval(() => {
    // This does nothing but keeps the Node process alive
    // const tick = Date.now(); 
}, 60000);

// --- 5. BOOT SYSTEM ---
let redis = null;

async function bootSystem() {
    console.log("⚙️ Booting Logic Engine...");

    // Connect Redis Safely
    if (process.env.REDIS_URL) {
        try {
            redis = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null, family: 4, retryStrategy: t => Math.min(t*50, 5000), enableReadyCheck: false
            });
            redis.on('connect', async () => {
                console.log('✅ DB Connected');
                state.dbOnline = true;
                // Load Data
                const a = await redis.get("active_signals");
                const h = await redis.get("history_log");
                if(a) state.activeSignals = JSON.parse(a);
                if(h) state.history = JSON.parse(h);
            });
            redis.on('error', e => { state.dbOnline = false; console.log("⚠️ DB Error (RAM Mode)"); });
        } catch (e) { console.log("⚠️ DB Init Failed"); }
    }

    // Check CEX
    if(process.env.BINGX_API_KEY) {
        try { await bingxRequest("GET", "/openApi/swap/v2/user/balance"); state.cexOnline = true; console.log("🟢 CEX Online"); } 
        catch(e) { state.cexOnline = false; }
    } else { state.cexOnline = false; }

    await sendExec(`🤖 <b>v137 ETERNAL ONLINE</b>\nMode: Safe Boot\nScanning: ${WATCHLIST_SIZE} Assets`);

    // Start Loops
    refreshUniverse();
    setInterval(refreshUniverse, 10 * 60 * 1000); 
    connectBinance();
    setInterval(manageActiveTrades, 2000);
    cron.schedule('30 18 * * *', handleDailyJanitor);
}

// --- DATABASE HELPER ---
async function saveState() {
    if(!redis || !state.dbOnline) return;
    try { await redis.set("active_signals", JSON.stringify(state.activeSignals)); await redis.set("history_log", JSON.stringify(state.history)); } catch(e){}
}

// --- SCANNER ---
async function refreshUniverse() {
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/24hr`);
        const data = res.data || [];
        
        // Global Context
        const btc = data.find(t => t.symbol === "BTCUSDT");
        if(btc) state.btcChange = parseFloat(btc.priceChangePercent);

        const fundRes = await axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex`);
        fundRes.data.forEach(f => { state.fundingRates[f.symbol] = parseFloat(f.lastFundingRate); });

        let candidates = data.filter(t => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > GLOBAL_MIN_VOLUME);
        candidates.sort((a,b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)));
        
        const top = candidates.slice(0, WATCHLIST_SIZE).map(t => t.symbol.toLowerCase());
        if (JSON.stringify(top) !== JSON.stringify(state.tickers)) {
            state.tickers = top;
            console.log(`🔥 Radar: ${state.tickers.length} Assets`);
            for(let sym of state.tickers) { 
                if(!state.candles[sym.toUpperCase()]) await fetchHistory(sym.toUpperCase()); 
            }
            subscribeWS();
        }
    } catch(e) {}
}

async function fetchHistory(symbol) {
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines`, { params: { symbol, interval: TIMEFRAME, limit: 150 } });
        state.candles[symbol] = res.data.map(k => ({ t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]) }));
    } catch(e) {}
}

function connectBinance() {
    if(state.ws) try{state.ws.close()}catch(e){}
    state.ws = new WebSocket(BINANCE_WS);
    state.ws.on('open', () => { 
        setTimeout(() => {
            subscribeWS();
            if(state.wsHeartbeat) clearInterval(state.wsHeartbeat);
            state.wsHeartbeat = setInterval(() => { if(state.ws.readyState===1) state.ws.ping() }, 30000);
        }, 2000);
    });
    state.ws.on('message', (msg) => { try { const data = JSON.parse(msg.toString()); if(data.e === 'kline') handleKline(data); } catch(e){} });
    state.ws.on('close', () => setTimeout(connectBinance, 5000));
}

function subscribeWS() {
    if(!state.tickers.length || state.ws.readyState !== WebSocket.OPEN) return;
    const streams = state.tickers.map(t => `${t}@kline_${TIMEFRAME}`);
    state.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: Date.now() }));
}

function handleKline(msg) {
    const symbol = msg.s; const k = msg.k;
    if(!state.candles[symbol]) state.candles[symbol] = [];
    const hist = state.candles[symbol];
    const nc = { t: k.t, o: parseFloat(k.o), h: parseFloat(k.h), l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v) };
    
    if(hist.length > 0 && hist[hist.length-1].t === nc.t) hist[hist.length-1] = nc;
    else { hist.push(nc); if(hist.length>155) hist.shift(); }

    state.lastRun = Date.now();
    const trade = state.activeSignals.find(s => s.symbol === symbol);
    if(trade) trade.current = nc.c;

    if(k.x && !trade && state.activeSignals.length < MAX_ACTIVE_SIGNALS) {
        const sig = analyzeCoin(symbol, hist);
        if(sig) executeSignal(sig);
    }
}

// --- SCORING ENGINE ---
function analyzeCoin(symbol, klines) {
  if (klines.length < 100) return null;
  const closes = klines.map(k => k.c); const vols = klines.map(k => k.v);
  const current = closes[closes.length - 1];
  const open = klines[klines.length - 1].o;

  const ema200 = calcEMA(closes, 200) || calcEMA(closes, 50); 
  const ema50 = calcEMA(closes, 50); const ema20 = calcEMA(closes, 20); 
  const rsi = calcRSI(closes, 7); 
  const atr = calcATR(klines, 14);
  const stoch = calcStochRSI(closes, 14, 14, 3, 3);
  const rvol = calcRVOL(vols, 20);
  const slope = calcSlope(closes, 20); 
  const dc = calcDonchian(klines, 50);
  const funding = state.fundingRates[symbol] || 0;
  
  if (!ema20 || !atr || !stoch || !dc) return null;

  let longScore = 0; let shortScore = 0;
  const dist = Math.abs(current - ema20) / ema20;
  const isGreen = current > open;
  const isRed = current < open;

  // 1. STRUCTURE (+20)
  if ((dc.high - current)/current > 0.005) longScore += 10; else longScore -= 15;
  if ((current - dc.low)/current > 0.005) shortScore += 10; else shortScore -= 15;

  // 2. TREND (+20)
  if (current > ema200) longScore += 10; else shortScore += 10; 
  if (slope > 5) longScore += 10; else if (slope < -5) shortScore += 10;

  // 3. MOMENTUM (+30)
  if (stoch.k < 20 && stoch.k > stoch.d) longScore += 20;
  if (stoch.k > 80 && stoch.k < stoch.d) shortScore += 20;
  const prevRsi = calcRSI(closes.slice(0, -1), 7);
  if (current < closes[closes.length-2] && rsi > prevRsi) longScore += 10; 
  if (current > closes[closes.length-2] && rsi < prevRsi) shortScore += 10; 

  // 4. VOLUME (+20)
  if (rvol > 1.5) { longScore += 10; shortScore += 10; }
  if (rvol > 3.0) { longScore += 10; shortScore += 10; }

  // 5. CONTEXT (-Points)
  if (funding > 0.05) longScore -= 20; if (funding < -0.05) shortScore -= 20;
  if (isRed) longScore -= 25; if (isGreen) shortScore -= 25; 
  if (state.btcChange < -3) longScore -= 15; if (state.btcChange > 3) shortScore -= 15;

  let type = null; let finalScore = 0; let strategy = "AI Logic";
  const passMark = rvol > 2.0 ? 60 : 70; // Dynamic Threshold

  if (longScore >= passMark && longScore > shortScore) { type = "LONG 🟢"; finalScore = longScore; }
  else if (shortScore >= passMark && shortScore > longScore) { type = "SHORT 🔴"; finalScore = shortScore; }

  if (!type) return null;

  if (rvol > 2.0) strategy = "Vol Breakout";
  else if (dist <= 0.04) strategy = "Smart Pullback";
  else strategy = "Structure Rev";

  const dir = type.includes('LONG') ? 1 : -1;
  const slDist = (strategy.includes("Breakout")) ? (atr * 1.5) : (atr * SL_MULT);
  const sl = parseFloat((current - (dir * slDist)).toFixed(6));
  
  if(Math.abs(sl - current) < current * 0.0015) return null;

  const tps = TP_MULTS.map(m => parseFloat((current + (dir * atr * m)).toFixed(6)));
  const riskPct = Math.abs(current - sl) / current * 100;
  let leverage = Math.floor(2.0 / (riskPct || 1)); 
  leverage = Math.max(5, Math.min(20, leverage));
  
  const calcRoi = (target) => ((Math.abs(target - current) / current) * 100 * leverage).toFixed(0);
  const slRoiVal = ((Math.abs(sl - current) / current) * 100 * leverage).toFixed(0);

  return {
    symbol, type, leverage, entry: current, sl, 
    slRoi: slRoiVal, tps, tpRois: tps.map(t => calcRoi(t)),
    timestamp: Date.now(), hits: [], peakRoi: 0, pnl: 0, setupQuality: `${strategy} (${finalScore})`
  };
}

// --- EXECUTION ---
async function executeSignal(sig) {
    if(state.activeSignals.length >= MAX_ACTIVE_SIGNALS) return;
    state.activeSignals.push(sig);
    await saveState();
    
    const prettySym = sig.symbol.replace("USDT", "-USDT");
    const msg = `🦅 <b>${prettySym}</b> (${TIMEFRAME})\n` +
                `Score: <b>${sig.setupQuality}</b>\n` +
                `Side: ${sig.type.replace(/ .*/,'')} ${sig.type.includes('LONG')?'🟢':'🔴'}\n` +
                `Lev: <b>${sig.leverage}x</b>\n\n` +
                `Entry: <code>${sig.entry}</code>\n` +
                `Stop Loss: <code>${sig.sl}</code> (-${sig.slRoi}%)\n\n` +
                `🎯 <b>Targets:</b>\n` + 
                `1: <code>${sig.tps[0]}</code> (+${sig.tpRois[0]}%)\n` +
                `2: <code>${sig.tps[1]}</code> (+${sig.tpRois[1]}%)\n` +
                `3: <code>${sig.tps[2]}</code> (+${sig.tpRois[2]}%)\n` +
                `4: <code>${sig.tps[3]}</code> (+${sig.tpRois[3]}%)`;

    await sendSignal(msg);

    if(!state.cexOnline) return;

    try {
        const bingxSym = prettySym;
        const isLong = sig.type.includes("LONG");
        const tickerRes = await axios.get(`${BINGX_URL}/openApi/swap/v2/quote/ticker?symbol=${bingxSym}`);
        const curPrice = parseFloat(tickerRes.data.data.lastPrice);
        let orderType = "MARKET"; let priceParam = {};
        if (isLong) { if (curPrice > sig.entry * 1.002) { orderType = "LIMIT"; priceParam = { price: sig.entry }; } } 
        else { if (curPrice < sig.entry * 0.998) { orderType = "LIMIT"; priceParam = { price: sig.entry }; } }
        const qty = (COST_PER_TRADE * sig.leverage) / (orderType==="LIMIT" ? sig.entry : curPrice);
        
        await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol: bingxSym, side: "LONG", leverage: sig.leverage });
        await bingxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol: bingxSym, side: "SHORT", leverage: sig.leverage });
        await bingxRequest("POST", "/openApi/swap/v2/trade/order", { symbol: bingxSym, side: isLong ? "BUY" : "SELL", type: orderType, quantity: qty.toFixed(4), positionSide: isLong ? "LONG" : "SHORT", ...priceParam });

        await placeAlgo(bingxSym, isLong, "SL", sig.sl, null, true);
        try { await placeAlgo(bingxSym, isLong, "TP", sig.tps[0], (qty * 0.4).toFixed(4)); } catch(e){}
        try { await placeAlgo(bingxSym, isLong, "TP", sig.tps[1], (qty * 0.2).toFixed(4)); } catch(e){}
        try { await placeAlgo(bingxSym, isLong, "TP", sig.tps[2], (qty * 0.2).toFixed(4)); } catch(e){}
        await placeAlgo(bingxSym, isLong, "TP", sig.tps[3], null, true);
        await sendExec(`🟢 <b>OPENED ${bingxSym}</b> (${orderType})`);
    } catch(e) { 
        await sendExec(`⚠️ <b>FAIL ${prettySym}</b>: ${e.message}`);
        state.activeSignals = state.activeSignals.filter(s => s.id !== sig.id);
        await saveState(); 
    }
}

// --- MANAGER ---
async function manageActiveTrades() {
    let changed = false; let keep = [];
    for(let s of state.activeSignals) {
        if(!s.current) { keep.push(s); continue; }
        const isLong = s.type.includes("LONG");
        const current = s.current;
        
        const stats = calculateStats(s, current);
        s.pnl = stats.pnl; s.roi = stats.roi;

        let close = false; let exitPrice = current; let reason = "";
        if ((Date.now() - s.timestamp) / 3600000 >= STALE_TRADE_HOURS) { close = true; reason = 'Time Limit 💤'; }
        const bingxSym = s.symbol.replace("USDT", "-USDT");

        if (!close) {
            for (let i = 0; i < 4; i++) {
                const tp = s.tps[i];
                const hit = isLong ? (current >= tp) : (current <= tp);
                if (hit && !s.hits.includes(i + 1)) {
                    s.hits.push(i + 1); changed = true;
                    const tpRoi = s.tpRois[i];
                    await sendSignal(`⚡ <b>${bingxSym} TP${i+1} HIT</b>\nROI: +${tpRoi}% 💰\nCurrent: <code>${current}</code>`);
                    if(state.cexOnline) await sendExec(`💰 <b>TP${i+1} HIT ${bingxSym}</b>`);
                    if (i === 3) { close = true; exitPrice = tp; reason = "TP4 MAX 🚀"; break; }
                    let newSL = null;
                    if(i === 0) newSL = s.entry; else if(i > 0) newSL = s.tps[i-1];
                    if(newSL) {
                        s.sl = newSL;
                        if(state.cexOnline) { 
                            await cancelAlgo(bingxSym);
                            await placeAlgo(bingxSym, isLong, "SL", s.sl, null, true);
                            await sendExec(`🛡️ <b>${bingxSym}</b> SL -> ${s.sl}`);
                        }
                    }
                }
            }
        }

        if (!close) {
            const slHit = isLong ? (current <= s.sl) : (current >= s.sl);
            if (slHit) { close = true; exitPrice = s.sl; reason = s.hits.length > 0 ? "Trailing Profit" : "SL 🛑"; }
        }

        if (close) {
            changed = true;
            const finalStats = calculateStats(s, exitPrice);
            let peakRoi = finalStats.roi;
            if(s.hits && s.hits.length > 0) {
                const maxHit = Math.max(...s.hits);
                const tpRoi = s.tpRois[maxHit-1];
                if(parseFloat(tpRoi) > parseFloat(peakRoi)) peakRoi = tpRoi;
            }
            s.finalPnl = finalStats.pnl; s.finalRoi = peakRoi;
            s.closedTime = Date.now(); s.reason = reason;
            state.history.unshift(s); 
            await saveState();
            const emoji = parseFloat(s.finalPnl) > 0 ? "✅" : "🛑";
            await sendSignal(`${emoji} <b>CLOSED ${bingxSym}</b> (${reason})\n💰 PnL: ${s.finalPnl}%\n🏆 ROI: ${s.finalRoi}%`);
            if(state.cexOnline) await sendExec(`🏁 <b>CLOSED ${bingxSym}</b>`);
        } else { keep.push(s); }
    }
    if(changed || state.activeSignals.length !== keep.length) { 
        state.activeSignals = keep; await saveState(); 
    }
}

// --- MATH ---
function calculateStats(s, exitPrice) {
    const entry = parseFloat(s.entry);
    const exit = parseFloat(exitPrice);
    const lev = parseFloat(s.leverage) || 1;
    const isLong = s.type.includes("LONG");
    if(!entry) return { pnl: "0.00", roi: "0.00" };
    const rawMove = isLong ? (exit - entry) / entry : (entry - exit) / entry;
    const roi = (rawMove * 100 * lev).toFixed(2);
    let totalPnl = 0; let sizeRemaining = 1.0;
    if (s.hits && s.hits.length > 0) {
        if (s.hits.includes(1)) { totalPnl += parseFloat(s.tpRois[0]) * 0.4; sizeRemaining -= 0.4; }
        if (s.hits.includes(2)) { totalPnl += parseFloat(s.tpRois[1]) * 0.2; sizeRemaining -= 0.2; }
        if (s.hits.includes(3)) { totalPnl += parseFloat(s.tpRois[2]) * 0.2; sizeRemaining -= 0.2; }
    }
    totalPnl += (rawMove * 100 * lev) * sizeRemaining;
    return { pnl: totalPnl.toFixed(2), roi: roi };
}

// --- UTILS ---
async function handleDailyJanitor() {
    const history = state.history;
    const calcStats = (days) => {
        const cut = Date.now() - (days * 24 * 60 * 60 * 1000);
        const subset = history.filter(h => h.closedTime > cut);
        const wins = subset.filter(h => parseFloat(h.finalPnl) > 0).length;
        const losses = subset.filter(h => parseFloat(h.finalPnl) < 0).length;
        const draws = subset.filter(h => parseFloat(h.finalPnl) == 0).length;
        const total = subset.length;
        const winrate = total ? ((wins/total)*100).toFixed(1) : 0;
        let pnl = 0; let roiSum = 0; let grossWin = 0; let grossLoss = 0;
        subset.forEach(h => {
            const p = parseFloat(h.finalPnl || 0);
            pnl += p; roiSum += parseFloat(h.finalRoi || h.finalPnl || 0);
            if(p > 0) grossWin += p; else grossLoss += Math.abs(p);
        });
        const avgRoi = total ? (roiSum / total).toFixed(0) : 0;
        const pf = grossLoss === 0 ? (grossWin > 0 ? 99.99 : 0) : (grossWin / grossLoss);
        return { total, winrate, pnl: pnl.toFixed(0), avgRoi, pf: pf.toFixed(2), wins, losses, draws };
    };
    const d1 = calcStats(1); const d7 = calcStats(7); const d30 = calcStats(30);
    const report = `📊 <b>DAILY STATS REPORT (IST)</b>\n\n` +
                   `<b>Last 24 Hours:</b>\n• Trades: ${d1.total} (W:${d1.wins} L:${d1.losses} D:${d1.draws})\n• Win Rate: ${d1.winrate}%\n• Net PnL: ${d1.pnl}%\n• PF: ${d1.pf} | Avg ROI: ${d1.avgRoi}%\n\n` +
                   `<b>Weekly (7D):</b>\n• Trades: ${d7.total} | WR: ${d7.winrate}%\n• PnL: ${d7.pnl}% | PF: ${d7.pf}\n\n` +
                   `<b>Monthly (30D):</b>\n• Trades: ${d30.total} | WR: ${d30.winrate}%\n• PnL: ${d30.pnl}% | PF: ${d30.pf}`;
    await sendSignal(report);
}
async function placeAlgo(symbol, isLong, type, price, qty=null, fullClose=false) {
    try {
        const side = isLong ? "SELL" : "BUY";
        const params = { symbol, side, type: type === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET", stopPrice: price.toFixed(6), workingType: "MARK_PRICE", positionSide: isLong ? "LONG" : "SHORT" };
        if (fullClose) params.closePosition = "true"; else if (qty) params.quantity = qty; else params.closePosition = "true";
        await bingxRequest("POST", "/openApi/swap/v2/trade/order", params);
    } catch(e) {}
}
async function cancelAlgo(symbol) { try { await bingxRequest("POST", "/openApi/swap/v2/trade/cancelAllAfter", { symbol, type: "STOP_MARKET" }); } catch(e) {} }
async function bingxRequest(method, endpoint, params = {}) {
    if (!process.env.BINGX_API_KEY) throw new Error("No Key");
    const apiKey = process.env.BINGX_API_KEY;
    const secretKey = process.env.BINGX_API_SECRET;
    let queryString = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const timestamp = Date.now();
    const finalParams = `${queryString}${queryString?'&':''}timestamp=${timestamp}`;
    const signature = CryptoJS.HmacSHA256(finalParams, secretKey).toString();
    const url = `${BINGX_URL}${endpoint}?${finalParams}&signature=${signature}`;
    try {
        const res = await axios({ method, url, headers: { "X-BX-APIKEY": apiKey } });
        if (res.data.code !== 0) throw new Error(res.data.msg);
        return res.data.data;
    } catch (e) { throw e; }
}
function calcEMA(data, period) { if (data.length < period) return []; const k = 2 / (period + 1); let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period; const res = [ema]; for (let i = period; i < data.length; i++) { ema = (data[i] - ema) * k + ema; res.push(ema); } return res; }
function calcRSI(data, period = 7) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const d = data[i] - data[i - 1]; if (d > 0) gains += d; else losses -= d; } let avgU = gains / period, avgD = losses / period; let rsi = 100 - (100 / (1 + avgU / (avgD || 1))); for (let i = period + 1; i < data.length; i++) { const d = data[i] - data[i - 1]; avgU = (avgU * (period - 1) + (d > 0 ? d : 0)) / period; avgD = (avgD * (period - 1) + (d < 0 ? -d : 0)) / period; rsi = 100 - (100 / (1 + avgU / (avgD || 1))); } return rsi; }
function calcATR(klines, period = 14) { if (klines.length < period + 1) return 0; let trs = []; for (let i = 1; i < klines.length; i++) { const h = klines[i].h, l = klines[i].l, c_prev = klines[i - 1].c; trs.push(Math.max(h - l, Math.abs(h - c_prev), Math.abs(l - c_prev))); } return trs.slice(-period).reduce((a, b) => a + b, 0) / period; }
function calcMACD(data, fast, slow, sig) { if(data.length < slow + sig) return null; const emaFast = calcEMA(data, fast); const emaSlow = calcEMA(data, slow); const macdLine = emaFast.map((v, i) => v - emaSlow[i]).slice(slow - fast); const signalLine = calcEMA(macdLine, sig); const currentMacd = macdLine[macdLine.length - 1]; const prevMacd = macdLine[macdLine.length - 2]; const currentSig = signalLine[signalLine.length - 1]; const prevSig = signalLine[signalLine.length - 2]; return { hist: currentMacd - currentSig, prevHist: prevMacd - prevSig }; }
function calcADX(klines, period) {
    if(klines.length < period * 2) return 0;
    let tr = [], dmPlus = [], dmMinus = [];
    for(let i=1; i<klines.length; i++) {
        const h=klines[i].h, l=klines[i].l, c=klines[i-1].c;
        tr.push(Math.max(h-l, Math.abs(h-c), Math.abs(l-c)));
        const up = h - klines[i-1].h; const down = klines[i-1].l - l;
        dmPlus.push(up > down && up > 0 ? up : 0);
        dmMinus.push(down > up && down > 0 ? down : 0);
    }
    const smooth = (arr) => {
        let res = [arr.slice(0, period).reduce((a,b)=>a+b, 0)];
        for(let i=period; i<arr.length; i++) res.push(res[res.length-1] - (res[res.length-1]/period) + arr[i]);
        return res;
    };
    const trS = smooth(tr); const dmPS = smooth(dmPlus); const dmMS = smooth(dmMinus);
    const dx = [];
    for(let i=0; i<trS.length; i++) {
        const diP = 100 * dmPS[i]/trS[i]; const diM = 100 * dmMS[i]/trS[i];
        dx.push(100 * Math.abs(diP - diM) / (diP + diM));
    }
    return dx.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function calcBB(data, period, mult) { if (data.length < period) return null; const sma = data.slice(0, period).reduce((a, b) => a + b, 0) / period; const squaredDiffs = data.slice(0, period).map(val => Math.pow(val - sma, 2)); const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period; const stdDev = Math.sqrt(variance); return { upper: sma + (mult * stdDev), lower: sma - (mult * stdDev), middle: sma }; }
function calcRVOL(vols, period) { if (vols.length < period) return 1; const cur = vols[vols.length - 1]; const avg = vols.slice(vols.length - period - 1, vols.length - 1).reduce((a,b)=>a+b,0) / period; return cur / (avg || 1); }
function calcStochRSI(data, rsiLen, stochLen, kSmooth, dSmooth) { const rsiFast = calcRSI(data, 7); const rsiSlow = calcRSI(data, 14); return { k: rsiFast, d: rsiSlow }; }
function calcDonchian(klines, period) { if(klines.length < period) return null; const slice = klines.slice(klines.length-period); const high = Math.max(...slice.map(k=>k.h)); const low = Math.min(...slice.map(k=>k.l)); return { high, low }; }
function calcSlope(arr, period) { if(arr.length < period) return 0; return (arr[arr.length-1] - arr[arr.length-period]) / arr[arr.length-period] * 10000; }
function calcMFI(klines, period) {
    if(klines.length < period + 1) return 50;
    let posFlow = 0, negFlow = 0;
    for(let i=klines.length-period; i<klines.length; i++) {
        const curr = klines[i], prev = klines[i-1];
        const tp = (curr.h + curr.l + curr.c) / 3;
        const tpPrev = (prev.h + prev.l + prev.c) / 3;
        const flow = tp * curr.v;
        if(tp > tpPrev) posFlow += flow; else negFlow += flow;
    }
    const ratio = posFlow / (negFlow || 1);
    return 100 - (100 / (1 + ratio));
}

function sendSignal(t){ if(process.env.TELEGRAM_SIGNAL_BOT_TOKEN) axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_SIGNAL_BOT_TOKEN}/sendMessage`, {chat_id:process.env.TELEGRAM_SIGNAL_CHAT_ID, text:t, parse_mode:'HTML'}).catch(()=>{}); }
function sendExec(t){ if(process.env.TELEGRAM_EXEC_BOT_TOKEN) axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_EXEC_BOT_TOKEN}/sendMessage`, {chat_id:process.env.TELEGRAM_EXEC_CHAT_ID, text:t, parse_mode:'HTML'}).catch(()=>{}); }

// --- UI (FIXED) ---
function renderHTML() { return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TheChartist v137</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"><style>:root{--bg:#0b0e11;--card:#151a21;--text:#e1e1e1;--green:#00ce7c;--red:#ff4d4d;--gray:#848e9c;--badge-green:rgba(0,206,124,0.15);--badge-red:rgba(255,77,77,0.15)}body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;margin:0;padding:16px;-webkit-font-smoothing:antialiased}.brand-wrapper{text-align:center;margin:20px 0 10px 0;position:relative}.brand-main{font-weight:800;font-size:1.6rem;font-style:italic;background:linear-gradient(135deg,#fff,#999);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.brand-sub{color:var(--green);font-size:.7rem;letter-spacing:3px;font-weight:700;text-transform:uppercase;margin-top:4px}.status-indicator{display:flex;justify-content:center;gap:15px;margin-bottom:15px;font-size:0.75rem;color:#666;text-transform:uppercase;font-weight:700}.dot{width:8px;height:8px;background:#444;border-radius:50%;display:inline-block;margin-right:6px}.dot.online{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}.dot.offline{background:var(--red);box-shadow:0 0 8px var(--red)}.stats-container{display:flex;gap:8px;overflow-x:auto;padding-bottom:10px;margin-bottom:20px;scrollbar-width:none}.stat-card{background:var(--card);border:1px solid #2a2e35;border-radius:12px;min-width:90px;padding:10px;flex:1;display:flex;flex-direction:column;align-items:center}.stat-header{font-size:.6rem;color:var(--gray);text-transform:uppercase;font-weight:600;margin-bottom:4px}.hero-winrate{font-size:1.1rem;font-weight:800;margin-bottom:6px}.badges-col{display:flex;flex-direction:column;gap:3px;width:100%;align-items:center}.badge{font-size:.55rem;padding:3px 6px;border-radius:4px;font-weight:700;width:100%;text-align:center;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bg-green{background:var(--badge-green);color:var(--green)}.bg-red{background:var(--badge-red);color:var(--red)}.stat-footer{font-size:.65rem;color:#fff;font-weight:700;margin-top:6px}.section-title{font-size:.75rem;color:var(--gray);text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px 0;font-weight:700}.signal-card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:12px;border:1px solid #252a30;position:relative;overflow:hidden;transition:transform .2s}.signal-card:active{transform:scale(.98)}.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.coin-info{display:flex;align-items:center;gap:10px}.coin-img{width:36px;height:36px;border-radius:50%;background:#222}.coin-name{font-weight:800;font-size:1.1rem}.dir-badge{padding:4px 8px;border-radius:6px;font-size:.7rem;font-weight:800;text-transform:uppercase;margin-left:8px}.badge-long{background:var(--badge-green);color:var(--green)}.badge-short{background:var(--badge-red);color:var(--red)}.card-pnl{text-align:right}.pnl-val{font-size:1.2rem;font-weight:800}.time-ago{font-size:.7rem;color:var(--gray);display:block}.timeline-box{position:relative;height:32px;margin:20px 0;padding:0 10px}.bar-bg{position:absolute;top:14px;left:0;width:100%;height:4px;background:#2a2e35;border-radius:2px}.bar-fill{position:absolute;top:14px;height:4px;border-radius:2px;transition:width .5s ease-out}.cur-marker{position:absolute;top:10px;width:2px;height:12px;background:#2979ff;z-index:10;box-shadow:0 0 6px #2979ff;transform:translateX(-50%);border-radius:1px}.bar-green{background:var(--green);box-shadow:0 0 10px rgba(0,206,124,.3)}.bar-red{background:var(--red);box-shadow:0 0 10px rgba(255,77,77,.3)}.timeline-dot{position:absolute;top:16px;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#151a21;border:2px solid var(--gray);z-index:2}.timeline-dot.active{background:#fff;border-color:#fff;width:10px;height:10px;z-index:5;box-shadow:0 0 0 4px rgba(255,255,255,.1)}.timeline-dot.hit{background:var(--green);border-color:var(--green);box-shadow:0 0 8px var(--green)}.dot-label{position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:.6rem;color:var(--gray);font-weight:700;white-space:nowrap}.active .dot-label{color:#fff}.details-box{display:none;margin-top:20px;padding-top:15px;border-top:1px solid #2a2e35}.expanded .details-box{display:block;animation:slideDown .3s ease}@keyframes slideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}.detail-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1e2329;font-size:.85rem}.d-label{color:var(--gray)}.d-val{font-weight:600;color:#fff;font-family:monospace;letter-spacing:.5px;cursor:pointer;transition:color .2s}.d-val:active{color:var(--green)}.row-hit{color:var(--green)}.row-hit .d-val{color:var(--green)}.green-text{color:var(--green)!important}.red-text{color:var(--red)!important}.roi-sub{font-size:.7em;opacity:.7;margin-left:4px;font-weight:400}.reset-btn{margin:30px auto;display:block;background:#222;color:#555;border:1px solid #333;padding:10px 20px;border-radius:8px;font-size:.7rem;cursor:pointer;transition:.2s}.reset-btn:hover{background:#ff4d4d;color:#fff;border-color:#ff4d4d}
.pnl-row { display: flex; gap: 8px; margin-top: 4px; }
.pnl-box { flex: 1; background: #1e2329; border-radius: 8px; padding: 8px; text-align: center; }
.pnl-box .lbl { font-size: 0.6rem; color: #888; text-transform: uppercase; margin-bottom: 2px; }
.pnl-box .val { font-size: 1rem; font-weight: 800; }
.green-text { color: #00ce7c !important; } .red-text { color: #ff4d4d !important; }
</style></head><body>
<div class="status-indicator"><div class="pill"><div class="dot" id="sysDot"></div>SYS</div><div class="pill"><div class="dot" id="dbDot"></div>DB</div><div class="pill"><div class="dot" id="cexDot"></div>CEX</div></div>
<div class="brand-wrapper"><div class="brand-main">_TheChartist_</div><div class="brand-sub">THE ETERNAL V137</div></div>
<div class="stats-container" id="statsBar"><div class="stat-card"><div>Loading...</div></div></div>
<div class="section-title">Active Signals <span id="activeCount" style="opacity:0.6; font-size:0.9em">(0)</span></div><div id="activeList"><div style="text-align:center;color:#444;padding:20px;">Scanning...</div></div>
<div class="section-title">Closed History <span id="historyCount" style="opacity:0.6; font-size:0.9em">(0)</span></div><div id="historyList"></div>
<button class="reset-btn" onclick="resetStats()">⚠️ RESET ALL HISTORY</button>
<script>
function fmt(n){return parseFloat(n).toFixed(6)}function timeAgo(t){if(!t)return'';const m=Math.floor((Date.now()-t)/6e4);if(m<60)return m+'m ago';const h=Math.floor(m/60);return h+(h===1?'hr ago':'hrs ago')}function copy(t){navigator.clipboard.writeText(t).catch(e=>console.error(e))}
function renderStats(active,history){const all=[...active,...history];const calc=d=>{const cut=Date.now()-(d*864e5);const sub=all.filter(h=>(h.closedTime||h.timestamp)>cut);const wins=sub.filter(h=>parseFloat(h.finalPnl)>0.01).length;const losses=sub.filter(h=>parseFloat(h.finalPnl)<-0.01).length;const draws=sub.filter(h=>Math.abs(parseFloat(h.finalPnl))<=0.01).length;const total=sub.length;const rate=total?((wins/total)*100).toFixed(1):0;let sumPnl=0;let roiSum=0;let gw=0;let gl=0;sub.forEach(h=>{const p=parseFloat(h.finalPnl||0);sumPnl+=p;roiSum+=parseFloat(h.finalRoi||h.finalPnl||0);if(p>0)gw+=p;else gl+=Math.abs(p)});const avgRoi=total?(roiSum/total).toFixed(0):0;let pf=0;if(sub.length>0){if(gl===0)pf=gw>0?99.99:0;else pf=gw/gl}return{total,wins,losses,draws,rate,pnl:sumPnl.toFixed(0),avgRoi,pf:pf.toFixed(2)}};const d1=calc(1);const d7=calc(7);const d14=calc(14);const d30=calc(30);const mc=(l,d)=>\`<div class="stat-card"><div class="stat-header">\${l}</div><div class="hero-winrate \${d.rate>=50?'green-text':'red-text'}" style="color:\${d.rate>=50?'var(--green)':'var(--red)'}">\${d.rate}%</div><div class="badges-col"><div class="badge \${d.pnl>=0?'bg-green':'bg-red'}">PnL: \${d.pnl>0?'+':''}\${d.pnl}%</div><div class="badge \${d.avgRoi>=0?'bg-green':'bg-red'}">ROI: \${d.avgRoi}%</div><div class="badge \${d.pf>=1?'bg-green':'bg-red'}">PF: \${d.pf}</div><div class="badge" style="background:#222;color:#666">W:\${d.wins} L:\${d.losses} D:\${d.draws}</div></div></div>\`;document.getElementById('statsBar').innerHTML=mc('24H',d1)+mc('7D',d7)+mc('14D',d14)+mc('30D',d30)}
function renderCard(s,isHist){const isLong=s.type.includes("LONG");const cur=s.current||s.entry;const pnl=parseFloat(s.finalPnl||s.pnl||0);const pnlTxt=(pnl>0?'+':'')+pnl+'%';const pnlColor=pnl>=0?'green-text':'red-text';const roi=s.finalRoi||(isLong?(cur-s.entry)/s.entry:(s.entry-cur)/s.entry)*100*s.leverage;const roiTxt=(roi>0?'+':'')+parseFloat(roi).toFixed(2)+'%';const roiColor=roi>=0?'green-text':'red-text';const badgeCls=isLong?'badge-long':'badge-short';const sl=parseFloat(s.sl);const entry=parseFloat(s.entry);const tps=s.tps;const hits=s.hits||[];const tpRois=s.tpRois||[];const slRoi=s.slRoi||'?';if(!tps||tps.length<4)return'';const maxVal=tps[3];const getPos=v=>{let pct;if(isLong)pct=((v-sl)/(maxVal-sl))*100;else pct=((sl-v)/(sl-maxVal))*100;return Math.max(0,Math.min(100,pct))};const posEntry=getPos(entry);const posCur=getPos(cur);const posTps=tps.map(t=>getPos(t));let barL=Math.min(posEntry,posCur);let barW=Math.abs(posCur-posEntry);const barCls=pnl>=0?'bar-green':'bar-red';let entryLabel="Entry";let showSL=true;if(hits.includes(1)){showSL=false;entryLabel="Entry 🛡️"}let slTextClass="d-val";let slText=\`\${fmt(sl)} <span class="roi-sub">(-\${slRoi}%)</span>\`;if((isLong && sl > entry * 1.001) || (!isLong && sl < entry * 0.999)){slText=\`\${fmt(sl)} (Locked Profit 🔒)\`;slTextClass+=" green-text"}else if(Math.abs(sl-entry)<entry*0.0001){slText=\`\${fmt(sl)} (Risk Free 🛡️)\`;slTextClass+=" green-text"}return \`<div class="signal-card \${isHist?'':'active'}" onclick="this.classList.toggle('expanded')"><div class="card-head"><div class="coin-info"><img src="https://lcw.nyc3.cdn.digitaloceanspaces.com/production/currencies/64/\${s.symbol.replace('-USDT','').toLowerCase()}.png" class="coin-img" onerror="this.style.display='none'"><div><div class="coin-name">\${s.symbol}</div><span class="dir-badge \${badgeCls}">\${isLong?'BUY':'SELL'} \${s.leverage}x</span></div></div><div class="card-pnl"><div class="pnl-val" style="color:\${pnlColor}">\${pnlTxt}</div><div style="font-size:0.7em;color:#666;margin-top:4px">\${s.setupQuality||'Score: --'}</div><span class="time-ago">\${timeAgo(s.timestamp||s.openTime)} \${s.reason?'• '+s.reason:''}</span></div></div><div class="pnl-row"><div class="pnl-box"><div class="lbl">PnL (Bank)</div><div class="val \${pnlColor}">\${pnlTxt}</div></div><div class="pnl-box"><div class="lbl">ROI (Flex)</div><div class="val \${roiColor}">\${roiTxt}</div></div></div><div class="timeline-box"><div class="bar-bg"></div><div class="bar-fill \${barCls}" style="left:\${barL}%;width:\${barW}%"></div><div class="cur-marker" style="left:\${posCur}%"></div>\${showSL?\`<div class="timeline-dot" style="left:0%"><div class="dot-label">SL</div></div>\`:''}<div class="timeline-dot active" style="left:\${posEntry}%"><div class="dot-label">\${entryLabel}</div></div>\${tps.map((t,i)=>\`<div class="timeline-dot \${hits.includes(i+1)?'hit':''}" style="left:\${posTps[i]}%"><div class="dot-label">T\${i+1}</div></div>\`).join('')}</div><div class="details-box"><div class="detail-row"><span class="d-label">Entry Price</span><span class="d-val" onclick="event.stopPropagation();copy('\${entry}')">\${fmt(entry)}</span></div><div class="detail-row"><span class="d-label">Stop Loss</span><span class="\${slTextClass}" onclick="event.stopPropagation();copy('\${sl}')">\${slText}</span></div>\${tps.map((tp,i)=>\`<div class="detail-row \${hits.includes(i+1)?'row-hit':''}"><span class="d-label">Target \${i+1} \${hits.includes(i+1)?'✅':''}</span><span class="d-val" onclick="event.stopPropagation();copy('\${tp}')">\${fmt(tp)} <span class="roi-sub">(+\${tpRois[i]}%)</span></span></div>\`).join('')}</div></div>\`}
async function load(){try{const res=await fetch('/api/data');const d=await res.json();const online=(Date.now()-parseInt(d.lastRun))<120000;document.getElementById('sysDot').className=online?'dot online':'dot offline';document.getElementById('cexDot').className=d.cexOnline?'dot online':'dot offline';document.getElementById('dbDot').className=d.dbOnline?'dot online':'dot offline';renderStats(d.active,d.history);document.getElementById('activeCount').innerText=\`(\${d.active.length})\`;document.getElementById('historyCount').innerText=\`(\${d.history.length})\`;document.getElementById('activeList').innerHTML=d.active.reverse().map(s=>renderCard(s,false)).join('')||'<div style="text-align:center;color:#666;padding:20px;">No Active Signals</div>';document.getElementById('historyList').innerHTML=d.history.slice(0,50).map(s=>renderCard(s,true)).join('')}catch(e){console.log(e)}}
async function resetStats(){if(!confirm("Reset ALL history?"))return;await fetch('/api/reset',{method:'POST'});alert("Done.");location.reload()}
load();setInterval(load,5000);
</script></body></html>`;
}


