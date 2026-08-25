// Deriv CRASH1000 spike-catch bot - designed to run via GitHub Actions on a schedule
// Each run: checks on any open trade, then looks for a new entry, then saves state and exits.

const WebSocket = require('ws');
const fs = require('fs');

// ---------- SETTINGS (same values as the browser version) ----------
const APP_ID = '347Poa0qcVM2mGBnOTjZj';
const SYMBOL = 'CRASH1000';
const TIMEFRAME = 3600; // 1hr candles
const TREND_MA_PERIOD = 50;
const ATR_PERIOD = 14;
const MIN_ATR_PCT = 0.05;
const MAX_ATR_PCT = 3;
const SPIKE_THRESHOLD_PCT = 0.35; // LOOSENED to fire more often - real win rate at this threshold is not yet proven, watch actual results
const FALLBACK_THRESHOLD_PCT = 0.1;  // much lower bar - used ONLY as a late-day fallback so a trade happens most days
const FORCE_TRADE_UTC_HOUR = 20;     // if no real signal has fired by this hour (UTC) and no trade yet today, use the fallback
const STAKE = 10;
const RISK_PCT_OF_BALANCE = 0.10;
const MIN_STAKE = 1;
const MULTIPLIER = 100;
const TAKE_PROFIT_MULTIPLE_OF_STAKE = 5; // target: win 5x your stake in ONE trade
const STOP_LOSS_FRACTION_OF_STAKE = 0.5; // lose at most half your stake if wrong

const STATE_FILE = './state.json';
const TOKEN = process.env.DERIV_TOKEN;

function log(msg) { console.log(`${new Date().toISOString()} - ${msg}`); }

const VIRTUAL_STARTING_BALANCE = 10; // pretend you started with this, regardless of Deriv's actual (inflated) demo balance

function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.virtualBalance) state.virtualBalance = VIRTUAL_STARTING_BALANCE; // add it if upgrading from an older state file
    if (!state.openContractId) state.openContractId = null;
    if (state.date === today) return state;
    return { ...state, date: today, tradesToday: 0 }; // keep virtualBalance/openContractId across days, only reset daily counter
  }
  return { date: today, tradesToday: 0, virtualBalance: VIRTUAL_STARTING_BALANCE, openContractId: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Indicator math (same formulas as the browser version) ----------
function calculateSMA(candles, period) {
  const recent = candles.slice(-period);
  return recent.reduce((a, c) => a + c.close, 0) / recent.length;
}
function getTrend(candles) {
  return candles[candles.length - 1].close > calculateSMA(candles, TREND_MA_PERIOD) ? 'up' : 'down';
}
function calculateATRPct(candles, period) {
  const recent = candles.slice(-period - 1);
  let trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
    trSum += tr;
  }
  const atr = trSum / (recent.length - 1);
  return (atr / candles[candles.length - 1].close) * 100;
}
function isDownSpike(candles, lookback = 4) {
  const recent = candles.slice(-lookback);
  return recent.some(c => ((c.open - c.low) / c.open) * 100 >= SPIKE_THRESHOLD_PCT);
}

async function main() {
  if (!TOKEN) { log('ERROR: DERIV_TOKEN secret not set.'); process.exit(1); }

  let state = loadState();
  log(`Loaded state: ${JSON.stringify(state)}`);

  // ---------- Get accounts, find demo account ----------
  const accountsRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
    headers: { 'Deriv-App-ID': APP_ID, 'Authorization': 'Bearer ' + TOKEN }
  });
  const accountsData = await accountsRes.json();
  const accounts = accountsData.data || [];
  const demoAccount = accounts.find(a => a.account_type === 'demo' || a.is_virtual === true);
  if (!demoAccount) { log('No demo account found. Stopping - will not use a real account.'); process.exit(1); }
  log(`Using demo account: ${demoAccount.account_id || demoAccount.id}`);

  // ---------- Get one-time WebSocket link ----------
  const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${demoAccount.account_id || demoAccount.id}/otp`, {
    method: 'POST',
    headers: { 'Deriv-App-ID': APP_ID, 'Authorization': 'Bearer ' + TOKEN }
  });
  const otpData = await otpRes.json();
  const wsUrl = otpData.data.url;

  const ws = new WebSocket(wsUrl);
  let reqIdCounter = 1;
  const pending = {};

  function sendRequest(payload) {
    return new Promise((resolve) => {
      const reqId = reqIdCounter++;
      payload.req_id = reqId;
      pending[reqId] = resolve;
      ws.send(JSON.stringify(payload));
    });
  }

  await new Promise((resolve) => ws.on('open', resolve));
  log('Connected and authenticated.');

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.req_id && pending[data.req_id]) {
      pending[data.req_id](data);
      delete pending[data.req_id];
    }
  });

  // ---------- Step 1: if we were tracking an open contract, check whether it closed and update virtual balance ----------
  if (state.openContractId) {
    const checkResp = await sendRequest({ proposal_open_contract: 1, contract_id: state.openContractId });
    const c = checkResp.proposal_open_contract;
    if (c && c.is_sold) {
      state.virtualBalance = Math.round((state.virtualBalance + c.profit) * 100) / 100;
      log(`Previous trade closed: ${c.profit >= 0 ? 'WIN' : 'LOSS'} $${c.profit.toFixed(2)}. Virtual balance now $${state.virtualBalance.toFixed(2)}`);
      state.openContractId = null;
    } else {
      log(`Previous trade (contract ${state.openContractId}) is still open.`);
    }
  }

  // ---------- Step 2: check directly with Deriv whether a trade is already open ----------
  const portfolioResp = await sendRequest({ portfolio: 1 });
  const openContracts = (portfolioResp.portfolio && portfolioResp.portfolio.contracts) || [];

  if (openContracts.length > 0) {
    log(`A trade is already open (contract ${openContracts[0].contract_id}) - waiting for it to close before looking for a new one.`);
  } else {
    // ---------- Step 3: look for a new signal, sizing stake off our own tracked virtual balance ----------
    log(`Virtual balance (what we're actually sizing trades from): $${state.virtualBalance.toFixed(2)}`);

    const candlesResp = await sendRequest({
      ticks_history: SYMBOL, adjust_start_time: 1, count: 100, end: 'latest',
      granularity: TIMEFRAME, style: 'candles'
    });
    const candles = candlesResp.candles;
    const spike = isDownSpike(candles);
    const atrPct = calculateATRPct(candles, ATR_PERIOD);
    const utcHour = new Date().getUTCHours();
    log(`Spike: ${spike}. Trend: ${getTrend(candles)}. ATR: ${atrPct.toFixed(3)}%. UTC hour: ${utcHour}. Traded today: ${state.tradesToday}`);

    // Fallback: if no real signal has fired and it's late in the day and we haven't traded yet,
    // check the recent candles against a much lower bar instead of doing nothing
    let usingFallback = false;
    let fallbackSignal = false;
    if (!spike && state.tradesToday === 0 && utcHour >= FORCE_TRADE_UTC_HOUR) {
      const recent = candles.slice(-4);
      fallbackSignal = recent.some(c => ((c.open - c.low) / c.open) * 100 >= FALLBACK_THRESHOLD_PCT);
      usingFallback = true;
      log(`No real signal yet today and it's past ${FORCE_TRADE_UTC_HOUR}:00 UTC - checking fallback (lower conviction) threshold: ${fallbackSignal}`);
    }

    const shouldTrade = (spike || fallbackSignal) && atrPct >= MIN_ATR_PCT && atrPct <= MAX_ATR_PCT;

    if (shouldTrade) {
      const MAX_STAKE = 1000; // Deriv's own hard cap per trade - discovered from a real rejected order
      const rawStake = Math.max(MIN_STAKE, state.virtualBalance * RISK_PCT_OF_BALANCE);
      const stake = Math.round(Math.min(rawStake, MAX_STAKE) * 100) / 100;
      const takeProfitDollar = Math.round(stake * TAKE_PROFIT_MULTIPLE_OF_STAKE * 100) / 100;
      const stopLossDollar = Math.round(stake * STOP_LOSS_FRACTION_OF_STAKE * 100) / 100;

      log(`${usingFallback ? 'FALLBACK (low-conviction) ' : ''}Signal found - opening trade. Stake $${stake.toFixed(2)} (from virtual balance $${state.virtualBalance.toFixed(2)}) | target $${takeProfitDollar.toFixed(2)} | max loss $${stopLossDollar.toFixed(2)}`);
      const buyResp = await sendRequest({
        buy: '1', price: stake,
        parameters: {
          amount: stake, basis: 'stake', contract_type: 'MULTUP', currency: 'USD',
          multiplier: MULTIPLIER, underlying_symbol: SYMBOL,
          limit_order: { stop_loss: stopLossDollar, take_profit: takeProfitDollar }
        }
      });
      if (buyResp.buy) {
        log(`TRADE PLACED: contract id ${buyResp.buy.contract_id}`);
        state.tradesToday++;
        state.openContractId = buyResp.buy.contract_id;
      } else {
        log(`Buy failed: ${JSON.stringify(buyResp.error || buyResp)}`);
      }
    } else {
      log('No valid signal this run.');
    }
  }

  saveState(state);
  log(`Saved state: ${JSON.stringify(state)}`);
  ws.close();
  process.exit(0);
}

main().catch((err) => { log(`FATAL ERROR: ${err.message}`); process.exit(1); });
