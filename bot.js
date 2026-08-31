// Deriv CRASH1000 spike-catch bot - designed to run via GitHub Actions on a schedule
// Each run: checks on any open trade, then looks for a new entry, then saves state and exits.

const WebSocket = require('ws');
const fs = require('fs');

// ---------- SETTINGS (same values as the browser version) ----------
const APP_ID = '347Poa0qcVM2mGBnOTjZj';
const INSTRUMENTS = [
  { symbol: 'CRASH300', direction: 'buy' },   // Crash = drifts up, spikes down -> buy the spike
  { symbol: 'CRASH500', direction: 'buy' },
  { symbol: 'CRASH1000', direction: 'buy' },
  { symbol: 'BOOM300', direction: 'sell' },   // Boom = drifts down, spikes up -> sell the spike
  { symbol: 'BOOM500', direction: 'sell' },
  { symbol: 'BOOM1000', direction: 'sell' },
]; // scans all of these each run, trades whichever fires first - not all may be available on every account, script skips ones that error
const TIMEFRAME = 900; // 15min candles - our own diagnostics showed spikes get diluted at 1hr scale
const TREND_MA_PERIOD = 50;
const ATR_PERIOD = 14;
const MIN_ATR_PCT = 0.05;
const MAX_ATR_PCT = 3;
const SPIKE_THRESHOLD_PCT = 0.35; // LOOSENED to fire more often - real win rate at this threshold is not yet proven, watch actual results
const FALLBACK_THRESHOLD_PCT = 0.1;  // much lower bar - used ONLY as a late-day fallback so a trade happens most days
const FORCE_TRADE_UTC_HOUR = 20;     // no longer gates the fallback (kept only for reference/logging)
const MAX_TRADES_PER_DAY = 3;        // hard cap on total trades per day, real + weak combined
const WEAK_TAKE_PROFIT_MULTIPLE_OF_STAKE = 2; // weak/fallback trades target a smaller, more realistic win instead of the full 5x
const LOCK_IN_ARM_DOLLARS = 1;       // real-signal trades: trailing stop "arms" once profit first reaches this
const WEAK_LOCK_IN_ARM_DOLLARS = 0.5; // weak-signal trades: arms sooner, smaller target to begin with
const TRAIL_DRAWBACK_PCT = 0.3;      // once armed, sell if profit falls back this much (30%) from its peak so far
const MIN_HOLD_SECONDS_BEFORE_LOCK_IN = 1800; // don't lock in on the first 30 minutes - avoids overreacting to normal noise
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
    if (typeof state.openContractPeakProfit !== 'number') state.openContractPeakProfit = 0;
    if (state.date === today) return state;
    return { ...state, date: today, tradesToday: 0 }; // keep virtualBalance/openContractId across days, only reset daily counter
  }
  return { date: today, tradesToday: 0, virtualBalance: VIRTUAL_STARTING_BALANCE, openContractId: null, openContractPeakProfit: 0 };
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
function isSpike(candles, direction, lookback = 4) {
  const recent = candles.slice(-lookback);
  if (direction === 'buy') { // Crash-type: look for a sharp DOWN move
    return recent.some(c => ((c.open - c.low) / c.open) * 100 >= SPIKE_THRESHOLD_PCT);
  } else { // Boom-type: look for a sharp UP move
    return recent.some(c => ((c.high - c.open) / c.open) * 100 >= SPIKE_THRESHOLD_PCT);
  }
}
function isFallbackSpike(candles, direction, lookback = 4) {
  const recent = candles.slice(-lookback);
  if (direction === 'buy') {
    return recent.some(c => ((c.open - c.low) / c.open) * 100 >= FALLBACK_THRESHOLD_PCT);
  } else {
    return recent.some(c => ((c.high - c.open) / c.open) * 100 >= FALLBACK_THRESHOLD_PCT);
  }
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

  // ---------- Step 1: if we were tracking an open contract, check whether it closed, or trail its profit ----------
  if (state.openContractId) {
    const checkResp = await sendRequest({ proposal_open_contract: 1, contract_id: state.openContractId });
    const c = checkResp.proposal_open_contract;
    if (c && c.is_sold) {
      const profit = Number(c.profit); // Deriv sometimes returns this as text, not a plain number - convert defensively
      state.virtualBalance = Math.round((state.virtualBalance + profit) * 100) / 100;
      log(`Previous trade closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}. Virtual balance now $${state.virtualBalance.toFixed(2)}`);
      state.openContractId = null;
      state.openContractPeakProfit = 0;
    } else if (c) {
      const currentProfit = Number(c.profit);
      const secondsOpen = Math.floor(Date.now() / 1000) - Number(c.purchase_time || c.date_start || 0);
      const heldLongEnough = secondsOpen >= MIN_HOLD_SECONDS_BEFORE_LOCK_IN;
      const armThreshold = state.openContractIsWeak ? WEAK_LOCK_IN_ARM_DOLLARS : LOCK_IN_ARM_DOLLARS;

      // Track the best profit this trade has ever shown, so we can tell if it's pulling back from a peak
      const peakProfit = Math.max(state.openContractPeakProfit || 0, currentProfit);
      state.openContractPeakProfit = peakProfit;
      const isArmed = peakProfit >= armThreshold;
      const pulledBack = isArmed && currentProfit <= peakProfit * (1 - TRAIL_DRAWBACK_PCT);

      log(`Previous trade (contract ${state.openContractId}) still open. Current profit: $${currentProfit.toFixed(2)}. Peak so far: $${peakProfit.toFixed(2)}. Armed: ${isArmed}. Held for ${Math.floor(secondsOpen / 60)} min.`);

      if (isArmed && pulledBack && heldLongEnough) {
        log(`Profit pulled back from peak $${peakProfit.toFixed(2)} to $${currentProfit.toFixed(2)} (more than ${(TRAIL_DRAWBACK_PCT * 100)}% giveback) - selling now to lock in the gain.`);
        const sellResp = await sendRequest({ sell: state.openContractId, price: 0 });
        if (sellResp.sell) {
          state.virtualBalance = Math.round((state.virtualBalance + currentProfit) * 100) / 100;
          log(`LOCKED IN: closed early with profit $${currentProfit.toFixed(2)} (peak was $${peakProfit.toFixed(2)}). Virtual balance now $${state.virtualBalance.toFixed(2)}`);
          state.openContractId = null;
          state.openContractPeakProfit = 0;
        } else {
          log(`Early sell failed: ${JSON.stringify(sellResp.error || sellResp)}`);
        }
      }
    }
  }

  // ---------- Step 2: check directly with Deriv whether a trade is already open ----------
  const portfolioResp = await sendRequest({ portfolio: 1 });
  const openContracts = (portfolioResp.portfolio && portfolioResp.portfolio.contracts) || [];

  if (openContracts.length > 0) {
    log(`A trade is already open (contract ${openContracts[0].contract_id}) - waiting for it to close before looking for a new one.`);
  } else {
    // ---------- Step 3: scan every instrument, trade the first one that fires ----------
    log(`Virtual balance (what we're actually sizing trades from): $${state.virtualBalance.toFixed(2)}`);
    const utcHour = new Date().getUTCHours();
    let tradedThisRun = false;
    let bestFallback = null; // remember the first fallback-eligible instrument in case nothing real fires

    for (const inst of INSTRUMENTS) {
      if (tradedThisRun) break;

      let candlesResp;
      try {
        candlesResp = await sendRequest({
          ticks_history: inst.symbol, adjust_start_time: 1, count: 100, end: 'latest',
          granularity: TIMEFRAME, style: 'candles'
        });
      } catch (e) {
        log(`${inst.symbol}: could not fetch candles (${e.message}), skipping.`);
        continue;
      }
      if (!candlesResp.candles) {
        log(`${inst.symbol}: not available on this account or no data, skipping.`);
        continue;
      }

      const candles = candlesResp.candles;
      const spike = isSpike(candles, inst.direction);
      const atrPct = calculateATRPct(candles, ATR_PERIOD);
      const volOk = atrPct >= MIN_ATR_PCT && atrPct <= MAX_ATR_PCT;
      log(`${inst.symbol} (${inst.direction}): spike=${spike}, trend=${getTrend(candles)}, ATR=${atrPct.toFixed(3)}%`);

      if (spike && volOk) {
        await placeTrade(inst, candles, false);
        tradedThisRun = true;
      } else if (!bestFallback && isFallbackSpike(candles, inst.direction) && volOk) {
        bestFallback = inst; // remember first eligible weak-signal candidate
      }
    }

    // Weak/fallback signal can now fire any time of day, not just late - but capped at MAX_TRADES_PER_DAY total
    if (!tradedThisRun && bestFallback && state.tradesToday < MAX_TRADES_PER_DAY) {
      log(`Weak (fallback) signal found on ${bestFallback.symbol} - trades today: ${state.tradesToday}/${MAX_TRADES_PER_DAY}`);
      const candlesResp = await sendRequest({
        ticks_history: bestFallback.symbol, adjust_start_time: 1, count: 100, end: 'latest',
        granularity: TIMEFRAME, style: 'candles'
      });
      await placeTrade(bestFallback, candlesResp.candles, true);
      tradedThisRun = true;
    }

    if (!tradedThisRun) {
      if (state.tradesToday >= MAX_TRADES_PER_DAY) log(`Daily trade cap reached (${state.tradesToday}/${MAX_TRADES_PER_DAY}). No more trades today.`);
      else log('No valid signal on any instrument this run.');
    }

    async function placeTrade(inst, candles, isWeak) {
      const MAX_STAKE = 1000;
      const rawStake = Math.max(MIN_STAKE, state.virtualBalance * RISK_PCT_OF_BALANCE);
      const stake = Math.round(Math.min(rawStake, MAX_STAKE) * 100) / 100;
      // Weak signals get a smaller, more realistic target instead of chasing the full 5x
      const targetMultiple = isWeak ? WEAK_TAKE_PROFIT_MULTIPLE_OF_STAKE : TAKE_PROFIT_MULTIPLE_OF_STAKE;
      const takeProfitDollar = Math.round(stake * targetMultiple * 100) / 100;
      const stopLossDollar = Math.round(stake * STOP_LOSS_FRACTION_OF_STAKE * 100) / 100;
      const contractType = inst.direction === 'buy' ? 'MULTUP' : 'MULTDOWN';

      log(`${isWeak ? 'WEAK SIGNAL ' : ''}Opening ${contractType} on ${inst.symbol}. Stake $${stake.toFixed(2)} (from virtual balance $${state.virtualBalance.toFixed(2)}) | target $${takeProfitDollar.toFixed(2)} | max loss $${stopLossDollar.toFixed(2)}`);
      const buyResp = await sendRequest({
        buy: '1', price: stake,
        parameters: {
          amount: stake, basis: 'stake', contract_type: contractType, currency: 'USD',
          multiplier: MULTIPLIER, underlying_symbol: inst.symbol,
          limit_order: { stop_loss: stopLossDollar, take_profit: takeProfitDollar }
        }
      });
      if (buyResp.buy) {
        log(`TRADE PLACED: contract id ${buyResp.buy.contract_id} on ${inst.symbol}`);
        state.tradesToday++;
        state.openContractId = buyResp.buy.contract_id;
        state.openContractIsWeak = isWeak; // remembered so we know which arm threshold to use while it's open
        state.openContractPeakProfit = 0;  // fresh trailing tracker for this new trade
      } else {
        log(`Buy failed on ${inst.symbol}: ${JSON.stringify(buyResp.error || buyResp)}`);
      }
    }
  }

  saveState(state);
  log(`Saved state: ${JSON.stringify(state)}`);
  ws.close();
  process.exit(0);
}

main().catch((err) => { log(`FATAL ERROR: ${err.message}`); process.exit(1); });
