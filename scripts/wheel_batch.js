#!/usr/bin/env node
// Wheel Strategy batch scanner — pure Node, no TradingView required.
//
// Reads a CSV of tickers, fetches OHLCV from Yahoo Finance, computes the same
// three-layer score the Wheel Triple Pine indicator produces (technical +
// Markov regime forecast + Monte Carlo strike risk + behavioral signals), and
// writes a ranked candidate report.
//
// Usage:
//   node scripts/wheel_batch.js --tickers scans/wheel_universe.csv
//   node scripts/wheel_batch.js --tickers scans/wheel_universe.csv --out scans/$(date +%F)_wheel-batch.md
//   node scripts/wheel_batch.js --tickers AAPL,JNJ,MSFT --dte 30 --paths 5000
//
// CSV format: one ticker per row. Optional header "symbol" or "ticker" is skipped.
//
// Output: markdown report to stdout (or --out file). Tickers ranked by verdict
// tier (ENTER_STRONG > ENTER > WATCH), then final_score desc.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (!args.tickers) {
  console.error('error: --tickers <csv-path-or-comma-list> required');
  usage(1);
}

const DTE          = intArg(args.dte, 37);
const PATHS        = intArg(args.paths, 5000);
const STRIKE_OTM   = floatArg(args['strike-otm'], 0.075);
const STRIKE_INCR  = floatArg(args['strike-incr'], 1.0);
const HORIZON      = intArg(args.horizon, 30);
const CONCURRENCY  = Math.max(1, intArg(args.concurrency, 4));
const OUT_PATH     = args.out || null;
const VERBOSE      = !!args.verbose;
const RF_RATE      = floatArg(args.rf, 0.045);          // risk-free annual rate
const IV_OVERRIDE  = args.iv != null ? floatArg(args.iv) : null; // optional annualized IV override
const ACCOUNT      = args.account != null ? floatArg(args.account) : null; // for position sizing
const MAX_POS_PCT  = floatArg(args['max-pos'], 0.10);   // max % of account per position

const tickers = loadTickers(args.tickers);
if (tickers.length === 0) {
  console.error('error: no tickers found');
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  if (VERBOSE) console.error(`Scanning ${tickers.length} tickers (concurrency=${CONCURRENCY})...`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tickers.length) return;
      const ticker = tickers[i];
      if (VERBOSE) console.error(`[${i+1}/${tickers.length}] ${ticker}`);
      try {
        results.push(await scanTicker(ticker));
      } catch (err) {
        results.push({ ticker, error: err.message });
      }
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));

  const report = renderReport(results);
  if (OUT_PATH) {
    writeFileSync(OUT_PATH, report);
    console.error(`Wrote ${OUT_PATH}`);
  } else {
    process.stdout.write(report);
  }
}

// ─── Per-ticker scan pipeline ─────────────────────────────────────────────
async function scanTicker(ticker) {
  const bars = await fetchYahooBars(ticker, '1y');
  if (bars.length < 100) throw new Error(`only ${bars.length} bars, need 100+`);

  const ind = computeIndicators(bars);
  const states = classifyRegimeSeries(bars);
  const behavioral = computeBehavioralAdj(bars, ind);

  const spot = bars[bars.length - 1].close;
  const strike = Math.round((spot * (1 - STRIKE_OTM)) / STRIKE_INCR) * STRIKE_INCR;

  // Annualized realized volatility (last 30 daily log returns × √252)
  const close = bars.map(b => b.close);
  const logRets = [];
  for (let i = Math.max(1, close.length - 30); i < close.length; i++) {
    if (close[i-1] > 0) logRets.push(Math.log(close[i] / close[i-1]));
  }
  const realizedVol = stdArr(logRets) * Math.sqrt(252);
  const sigma = IV_OVERRIDE ?? realizedVol;

  // Black-Scholes put pricing + greeks
  const T = DTE / 365;
  const bs = blackScholesPut(spot, strike, T, RF_RATE, sigma);

  const [markov, mc] = await Promise.all([
    runMarkov(states, HORIZON),
    runMonteCarlo(bars, strike, DTE, PATHS),
  ]);
  const final = await runBehavioralScore(ind.baseScore, markov.p_favorable_horizon, behavioral.adj);

  // MC downgrade: if p_assign > 0.40, knock one tier
  const verdictDowngraded = downgradeForMC(final.verdict, mc.gbm.p_assign);

  // Trade economics
  const premium     = bs.price;                        // theoretical credit per share
  const credit$     = premium * 100;                   // per contract
  const breakeven   = strike - premium;
  const maxLoss$    = (strike - premium) * 100;        // worst case: stock → 0
  const reqCash$    = strike * 100;                    // cash-secured put margin
  const annRoR      = (premium / strike) * (365 / DTE);
  const evPerTrade$ = premium * (1 - mc.gbm.p_assign) * 100
                    - (mc.gbm.e_loss_given_assign ?? 0) * mc.gbm.p_assign * 100;
  // POP from MC: terminal > breakeven
  const pop = mc.gbm.terminal_pct
    ? estimatePopFromPercentiles(mc.gbm.terminal_pct, breakeven, spot)
    : null;
  // Kelly fraction: b = win$ / loss$, p = win prob; f* = (bp - (1-p)) / b
  const lossPerShare = bs.price + Math.max(0, (mc.gbm.e_loss_given_assign ?? 0));
  const winProb = 1 - mc.gbm.p_assign;
  const b = lossPerShare > 0 ? premium / lossPerShare : 0;
  const kelly = b > 0 ? Math.max(0, (b * winProb - (1 - winProb)) / b) : 0;
  // Position sizing
  const sizing = ACCOUNT
    ? { contracts: Math.floor((ACCOUNT * MAX_POS_PCT) / reqCash$), capPct: MAX_POS_PCT }
    : null;

  return {
    ticker,
    spot,
    bbPct: ind.bbPct,
    rsi: ind.rsi[ind.rsi.length - 1],
    sma50: ind.sma50[ind.sma50.length - 1],
    baseScore: ind.baseScore,
    bbPass: ind.bbPass, smaPass: ind.smaPass, rsiPass: ind.rsiPass, gapPass: ind.gapPass,
    regimeState: states[states.length - 1],
    regimeName: STATE_NAMES[states[states.length - 1]],
    pFavorable: markov.p_favorable_horizon,
    regimeDist: markov.horizon_distribution,
    wheelGate: markov.wheel_gate,
    behavioral: behavioral.adj,
    behavioralFlags: behavioral.flags,
    realizedVol,
    sigmaUsed: sigma,
    rfRate: RF_RATE,
    strike,
    dte: DTE,
    bsPrice: bs.price,
    bsDelta: bs.delta,
    bsTheta: bs.theta,
    bsVega: bs.vega,
    bsGamma: bs.gamma,
    breakeven,
    credit$,
    maxLoss$,
    reqCash$,
    annRoR,
    evPerTrade$,
    pop,
    kelly,
    pAssign: mc.gbm.p_assign,
    pTouch: mc.gbm.p_touch,
    eLossGivenAssign: mc.gbm.e_loss_given_assign,
    terminalP5: mc.gbm.terminal_pct?.p5,
    terminalP50: mc.gbm.terminal_pct?.p50,
    terminalP95: mc.gbm.terminal_pct?.p95,
    sizing,
    finalScore: final.final_score,
    verdictBase: final.verdict,
    verdict: verdictDowngraded.verdict,
    mcDowngraded: verdictDowngraded.downgraded,
  };
}

// ─── Black-Scholes put + greeks ──────────────────────────────────────────
function blackScholesPut(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return { price: Math.max(K - S, 0), delta: S < K ? -1 : 0, theta: 0, vega: 0, gamma: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const nd1 = normPdf(d1);
  const price = K * Math.exp(-r * T) * (1 - Nd2) - S * (1 - Nd1);
  const delta = -(1 - Nd1);                              // put delta, in [-1, 0]
  const theta = (-(S * nd1 * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * (1 - Nd2)) / 365; // $/day
  const vega  = (S * nd1 * sqrtT) / 100;                 // $/1% IV
  const gamma = nd1 / (S * sigma * sqrtT);
  return { price, delta, theta, vega, gamma };
}
function normCdf(x) {
  // Abramowitz & Stegun 26.2.17
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// POP from terminal percentiles (linear interp between p5/p50/p95)
function estimatePopFromPercentiles(pct, breakeven, spot) {
  const pts = [{ p: 0.05, x: pct.p5 }, { p: 0.50, x: pct.p50 }, { p: 0.95, x: pct.p95 }];
  // Want P(terminal > breakeven) = 1 - CDF(breakeven)
  // Interp the inverse CDF, then 1 - p
  if (breakeven <= pts[0].x) return 0.95;
  if (breakeven >= pts[2].x) return 0.05;
  let p;
  if (breakeven <= pts[1].x) {
    const f = (breakeven - pts[0].x) / (pts[1].x - pts[0].x);
    p = pts[0].p + f * (pts[1].p - pts[0].p);
  } else {
    const f = (breakeven - pts[1].x) / (pts[2].x - pts[1].x);
    p = pts[1].p + f * (pts[2].p - pts[1].p);
  }
  return 1 - p;
}

function stdArr(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

// ─── Yahoo Finance fetcher (free chart API, no key needed) ───────────────
async function fetchYahooBars(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (wheel-batch)' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no chart data');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return bars;
}

// ─── Indicator math (port of WheelComposite/Triple Pine logic) ───────────
function computeIndicators(bars) {
  const close = bars.map(b => b.close);
  const open  = bars.map(b => b.open);
  const high  = bars.map(b => b.high);
  const low   = bars.map(b => b.low);
  const n = bars.length;

  // Bollinger (20, 2.0)
  const basis = sma(close, 20);
  const dev   = stdev(close, 20);
  const upper = basis.map((b, i) => b + 2 * dev[i]);
  const lower = basis.map((b, i) => b - 2 * dev[i]);
  const sma50 = sma(close, 50);
  const rsiArr = rsi(close, 14);
  const atrArr = atr(high, low, close, 14);

  const last = n - 1;
  const bbPct = (close[last] - lower[last]) / (upper[last] - lower[last]);
  const bbPass = bbPct <= 0.25;

  // SMA pass: below sma50 OR above for >=72 bars consecutively
  const belowSma = close[last] < sma50[last];
  let aboveBars = 0;
  for (let i = last; i >= 0; i--) {
    if (close[i] < sma50[i]) break;
    aboveBars++;
  }
  const aboveSmaLong = aboveBars >= 72;
  const smaPass = belowSma || aboveSmaLong;

  const rsiPass = rsiArr[last] <= 60;
  const rsiStrongHit = rsiArr[last] <= 30;
  const rsiOverbought = rsiArr[last] > 70;

  // 30-day gap check
  let gapHit = false;
  for (let i = 1; i <= 30 && last - i - 1 >= 0; i++) {
    const prev = close[last - i - 1];
    const cur = open[last - i];
    if (prev > 0 && Math.abs(cur - prev) / prev >= 0.10) { gapHit = true; break; }
  }
  const gapPass = !gapHit;

  const baseScore = (bbPass ? 1 : 0) + (smaPass ? 1 : 0) + (rsiPass ? 1 : 0) + (gapPass ? 1 : 0);

  return {
    basis, upper, lower, sma50, rsi: rsiArr, atr: atrArr,
    bbPct, bbPass, smaPass, rsiPass, rsiStrongHit, rsiOverbought, gapPass,
    baseScore,
    spot: close[last],
  };
}

// Regime classifier — port of RegimeClassifier.pine
//   0=TREND_DOWN, 1=VOLATILE, 2=RANGE, 3=TREND_UP
function classifyRegimeSeries(bars) {
  const close = bars.map(b => b.close);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const sma50 = sma(close, 50);
  const rsiArr = rsi(close, 14);
  const atrArr = atr(high, low, close, 14);
  const basis = sma(close, 20);
  const dev = stdev(close, 20);

  const states = [];
  for (let i = 0; i < close.length; i++) {
    // Need 60-bar atr median window — skip until valid
    if (i < 60) { states.push(2); continue; }
    const atrMed = median(atrArr.slice(Math.max(0, i - 60), i + 1).filter(v => Number.isFinite(v)));
    const a = atrArr[i];
    const c = close[i];
    const s = sma50[i];
    const r = rsiArr[i];
    const upper = basis[i] + 2 * dev[i];
    const lower = basis[i] - 2 * dev[i];
    const bbPct = (c - lower) / (upper - lower);

    const isVolatile = Number.isFinite(atrMed) && a > 1.5 * atrMed;
    const distFromSma = s > 0 ? Math.abs(c - s) / s : NaN;
    const isRange = Number.isFinite(distFromSma) && distFromSma <= 0.03 && r >= 40 && r <= 60;
    const isTrendUp = c > s && r >= 50 && r <= 70 && bbPct >= 0.4 && bbPct <= 0.8 && !isVolatile;
    const isTrendDown = c < s && r < 50 && bbPct < 0.4 && !isVolatile;

    let state = 2; // default RANGE
    if (isVolatile) state = 1;
    else if (isTrendUp) state = 3;
    else if (isTrendDown) state = 0;
    else if (isRange) state = 2;
    states.push(state);
  }
  return states;
}

// Behavioral signals — port of BehavioralOverlay.pine
function computeBehavioralAdj(bars, ind) {
  const close = bars.map(b => b.close);
  const open = bars.map(b => b.open);
  const volume = bars.map(b => b.volume);
  const n = bars.length;
  const last = n - 1;

  const volSma = sma(volume, 60);
  const volStd = stdev(volume, 60);
  const volZ = volStd[last] > 0 ? (volume[last] - volSma[last]) / volStd[last] : 0;
  const greenBar = close[last] > open[last];
  const capitulation = volZ >= 2.0 && ind.rsi[last] <= 30 && greenBar;

  const prevClose = close[last - 1] || 0;
  const gdPct = prevClose !== 0 ? (open[last] - prevClose) / prevClose : 0;
  const gdHit = gdPct <= -0.03;
  const failedGap = gdHit && close[last] > open[last];
  const trapGap = gdHit && close[last] <= open[last];

  const c = close[last];
  const distSm = Math.abs(c - Math.round(c / 5) * 5) / c;
  const distMd = Math.abs(c - Math.round(c / 10) * 10) / c;
  const distLg = Math.abs(c - Math.round(c / 50) * 50) / c;
  const anchorHit = distSm < 0.005 || distMd < 0.005 || distLg < 0.005;

  let adj = 0;
  const flags = [];
  if (capitulation) { adj += 1.0; flags.push('capitulation'); }
  if (failedGap)    { adj += 0.5; flags.push('failed-gap'); }
  if (trapGap)      { adj -= 1.0; flags.push('trap-gap'); }
  if (anchorHit)    { adj += 0.5; flags.push('anchor'); }
  adj = Math.max(-2, Math.min(2, adj));

  return { adj, flags, volZ };
}

// MC downgrade rule (matches Wheel Triple)
function downgradeForMC(verdict, pAssign) {
  if (pAssign <= 0.40) return { verdict, downgraded: false };
  const tier = { 'ENTER_STRONG': 'ENTER', 'ENTER': 'WATCH', 'WATCH': 'SKIP' };
  if (tier[verdict]) return { verdict: tier[verdict], downgraded: true };
  return { verdict, downgraded: false };
}

// ─── Spawn helpers for the existing pure-Node scripts ────────────────────
function runMarkov(states, horizon) {
  return runNodeScript('markov_regime.js', ['--stdin', '--horizon', String(horizon)], JSON.stringify({ states }));
}
function runMonteCarlo(bars, strike, dte, paths) {
  return runNodeScript('monte_carlo_strike.js',
    ['--stdin', '--strike', String(strike), '--dte', String(dte), '--paths', String(paths)],
    JSON.stringify({ bars }));
}
function runBehavioralScore(base, pFav, behavioral) {
  return runNodeScript('behavioral_score.js',
    ['--base', String(base), '--p-favorable', String(pFav), '--behavioral', String(behavioral)],
    null);
}

function runNodeScript(name, argsList, stdinPayload) {
  const scriptPath = resolve(__dirname, name);
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [scriptPath, ...argsList]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('error', rej);
    proc.on('close', code => {
      if (code !== 0) return rej(new Error(`${name} exited ${code}: ${err.trim()}`));
      try { res(JSON.parse(out)); } catch (e) { rej(new Error(`${name} bad JSON: ${out.slice(0,200)}`)); }
    });
    if (stdinPayload != null) {
      proc.stdin.write(stdinPayload);
    }
    proc.stdin.end();
  });
}

// ─── Math primitives ─────────────────────────────────────────────────────
function sma(arr, len) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] || 0;
    if (i >= len) sum -= arr[i - len] || 0;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
function stdev(arr, len) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = len - 1; i < arr.length; i++) {
    let mean = 0;
    for (let j = i - len + 1; j <= i; j++) mean += arr[j] || 0;
    mean /= len;
    let v = 0;
    for (let j = i - len + 1; j <= i; j++) v += ((arr[j] || 0) - mean) ** 2;
    out[i] = Math.sqrt(v / len);
  }
  return out;
}
function rsi(close, len) {
  const out = new Array(close.length).fill(NaN);
  if (close.length <= len) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= len; l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    g = (g * (len - 1) + gain) / len;
    l = (l * (len - 1) + loss) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function atr(high, low, close, len) {
  const out = new Array(close.length).fill(NaN);
  const tr = new Array(close.length).fill(NaN);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < close.length; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  let sum = 0;
  for (let i = 0; i < len; i++) sum += tr[i];
  out[len - 1] = sum / len;
  for (let i = len; i < close.length; i++) {
    out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
  }
  return out;
}
function median(arr) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── Report rendering ────────────────────────────────────────────────────
const STATE_NAMES = ['TREND_DOWN', 'VOLATILE', 'RANGE', 'TREND_UP'];

function rankKey(r) {
  if (r.error) return [99, 0];
  const tier = { 'ENTER_STRONG': 0, 'ENTER': 1, 'WATCH': 2, 'SKIP': 3, 'SKIP_REGIME': 4 }[r.verdict] ?? 5;
  return [tier, -r.finalScore];
}

function renderReport(results) {
  const sorted = [...results].sort((a, b) => {
    const ka = rankKey(a), kb = rankKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] - kb[1];
  });

  const date = new Date().toISOString().slice(0, 10);
  const tiers = { ENTER_STRONG: [], ENTER: [], WATCH: [], SKIP: [], SKIP_REGIME: [], errors: [] };
  for (const r of sorted) {
    if (r.error) tiers.errors.push(r);
    else (tiers[r.verdict] || tiers.SKIP).push(r);
  }

  let md = `# Wheel Batch Scan — ${date}\n\n`;
  md += `Scanned ${results.length} tickers · DTE ${DTE} · ~${(STRIKE_OTM*100).toFixed(1)}% OTM · ${PATHS} MC paths · Markov horizon ${HORIZON}\n\n`;
  md += `| Tier | Count |\n|---|---|\n`;
  for (const t of ['ENTER_STRONG','ENTER','WATCH','SKIP','SKIP_REGIME']) {
    if (tiers[t].length) md += `| ${t} | ${tiers[t].length} |\n`;
  }
  if (tiers.errors.length) md += `| ERROR | ${tiers.errors.length} |\n`;
  md += `\n`;

  for (const tier of ['ENTER_STRONG', 'ENTER', 'WATCH']) {
    if (!tiers[tier].length) continue;
    md += `## ${tier}\n\n`;
    for (const r of tiers[tier]) md += renderTickerBlock(r);
  }

  if (tiers.SKIP.length || tiers.SKIP_REGIME.length) {
    md += `## SKIP\n\n`;
    md += `| Ticker | Verdict | Score | Spot | RSI | BB% | Regime | p_fav | p_assign | Reason |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of [...tiers.SKIP, ...tiers.SKIP_REGIME]) {
      md += `| ${r.ticker} | ${r.verdict}${r.mcDowngraded?' (MC↓)':''} | ${fmt(r.finalScore,2)} | ${fmt(r.spot,2)} | ${fmt(r.rsi,1)} | ${pct(r.bbPct)} | ${r.regimeName} | ${pct(r.pFavorable)} | ${pct(r.pAssign)} | ${skipReason(r)} |\n`;
    }
    md += `\n`;
  }

  if (tiers.errors.length) {
    md += `## Errors\n\n`;
    for (const r of tiers.errors) md += `- **${r.ticker}** — ${r.error}\n`;
    md += `\n`;
  }

  return md;
}

function renderTickerBlock(r) {
  const flags = r.behavioralFlags.length ? ` · ${r.behavioralFlags.join(', ')}` : '';
  const dist = r.regimeDist
    ? `U${Math.round(r.regimeDist.TREND_UP*100)} R${Math.round(r.regimeDist.RANGE*100)} V${Math.round(r.regimeDist.VOLATILE*100)} D${Math.round(r.regimeDist.TREND_DOWN*100)}`
    : '';
  let md = `### ${r.ticker} — ${r.verdict}${r.mcDowngraded?' (MC↓)':''}  ·  score ${fmt(r.finalScore,2)}/6.00\n\n`;

  // ── Snapshot
  md += `**Snapshot:** spot $${fmt(r.spot,2)} · RSI ${fmt(r.rsi,1)} · BB% ${pct(r.bbPct)} · regime ${r.regimeName} · realized σ ${pct(r.realizedVol)}\n\n`;

  // ── The order
  md += `**ORDER — Sell cash-secured put**\n\n`;
  md += `| Parameter | Value |\n|---|---|\n`;
  md += `| Ticker | ${r.ticker} |\n`;
  md += `| Strike | **$${fmt(r.strike,2)}** (${pct((r.spot - r.strike)/r.spot)} OTM) |\n`;
  md += `| DTE | **${r.dte} days** |\n`;
  md += `| Target credit (BS theoretical) | **$${fmt(r.bsPrice,2)}/share = $${fmt(r.credit$,0)}/contract** |\n`;
  md += `| Limit order | at mid, do NOT cross spread |\n`;
  md += `| Delta (BS) | ${fmt(r.bsDelta,2)} (~${Math.abs(Math.round(r.bsDelta*100))}Δ) |\n`;
  md += `| Cash required | $${fmt(r.reqCash$,0)} per contract |\n`;
  if (r.sizing) {
    md += `| Position size | **${r.sizing.contracts} contract${r.sizing.contracts!==1?'s':''}** (${pct(r.sizing.capPct)} of $${fmt(ACCOUNT,0)}) |\n`;
  }
  md += `\n`;

  // ── Win/loss math
  md += `**Win / Loss math**\n\n`;
  md += `| Metric | Value | Meaning |\n|---|---|---|\n`;
  md += `| **POP** (probability of profit) | **${pct(r.pop)}** | Terminal price > break-even at expiry |\n`;
  md += `| P(no assignment) | ${pct(1 - r.pAssign)} | Expires worthless, keep full credit |\n`;
  md += `| P(assignment) | ${pct(r.pAssign)} | Forced to buy 100 shares at strike |\n`;
  md += `| P(touch) | ${pct(r.pTouch)} | Spot touches strike at any point (MTM drawdown) |\n`;
  md += `| Break-even price | $${fmt(r.breakeven,2)} | Below this = losing trade at expiry |\n`;
  md += `| Max profit | $${fmt(r.credit$,0)}/contract | Premium kept if expires OTM |\n`;
  md += `| Max loss | $${fmt(r.maxLoss$,0)}/contract | If stock goes to $0 |\n`;
  md += `| Expected loss if assigned | $${fmt((r.eLossGivenAssign??0)*100,0)}/contract | MC-modeled avg loss given assignment |\n`;
  md += `| **Expected value/trade** | **$${fmt(r.evPerTrade$,2)}/contract** | P(win)·credit − P(assign)·E[loss] |\n`;
  md += `| Annualized RoR | ${pct(r.annRoR)} | (premium/strike) × (365/DTE), uncompounded |\n`;
  md += `| Kelly fraction | ${pct(r.kelly)} | Optimal % of risk capital per trade |\n`;
  md += `\n`;

  // ── Greeks
  md += `**Greeks (Black-Scholes, σ=${pct(r.sigmaUsed)}, r=${pct(r.rfRate)})**\n\n`;
  md += `| Δ (delta) | Θ (theta/day) | V (vega/1%IV) | Γ (gamma) |\n|---|---|---|---|\n`;
  md += `| ${fmt(r.bsDelta,3)} | $${fmt(r.bsTheta,3)}/share | $${fmt(r.bsVega,3)}/share | ${fmt(r.bsGamma,4)} |\n\n`;

  // ── Layered scoring evidence
  md += `**Why this verdict** (3-layer model)\n\n`;
  md += `| Layer | Reading |\n|---|---|\n`;
  md += `| Technical (${r.baseScore}/4) | BB ${r.bbPass?'✓':'✗'} · SMA ${r.smaPass?'✓':'✗'} · RSI ${r.rsiPass?'✓':'✗'} · Gap ${r.gapPass?'✓':'✗'} |\n`;
  md += `| Markov (${HORIZON}d) | ${r.regimeName} now → p_favorable ${pct(r.pFavorable)} · dist ${dist} |\n`;
  md += `| Monte Carlo (${PATHS} paths) | terminal 5/50/95: $${fmt(r.terminalP5,2)} / $${fmt(r.terminalP50,2)} / $${fmt(r.terminalP95,2)} |\n`;
  md += `| Behavioral | ${r.behavioral>=0?'+':''}${fmt(r.behavioral,1)}${flags} |\n`;
  md += `| Composite | (base ${r.baseScore} × p_fav ${fmt(r.pFavorable,2)}) + behavioral ${fmt(r.behavioral,1)} = **${fmt(r.finalScore,2)}/6.00** |\n\n`;

  // ── Execution checklist
  md += `**Execution checklist:**\n`;
  md += `- [ ] IV is 30-60% (skip if outside — ${(r.sigmaUsed*100).toFixed(0)}% realized vol is your reference)\n`;
  md += `- [ ] Bid-ask spread < 5% of mid (skip if > 10%)\n`;
  md += `- [ ] Open interest > 1000, daily volume > 100\n`;
  md += `- [ ] Actual delta in ToS within ±5pp of BS delta ${fmt(r.bsDelta,2)} (else IV smile is meaningful)\n`;
  md += `- [ ] Place limit at mid; if not filled in 5min, walk price by $0.05\n`;
  md += `- [ ] Set GTC close at 50% of max profit ($${fmt(r.credit$*0.5,0)})\n\n`;

  return md;
}

function skipReason(r) {
  if (r.verdict === 'SKIP_REGIME') return `regime ${r.regimeName}`;
  if (r.mcDowngraded) return `MC p_assign ${pct(r.pAssign)} too high`;
  if (!r.bbPass) return 'price too high in BB';
  if (!r.rsiPass) return r.rsi > 70 ? `RSI ${fmt(r.rsi,0)} overbought` : `RSI ${fmt(r.rsi,0)} elevated`;
  if (!r.smaPass) return 'trend unclear';
  if (!r.gapPass) return 'recent ≥10% gap';
  return 'below threshold';
}

// ─── Utilities ───────────────────────────────────────────────────────────
function loadTickers(arg) {
  if (arg.includes(',') && !existsSync(arg)) {
    return arg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  if (!existsSync(arg)) throw new Error(`tickers file not found: ${arg}`);
  const text = readFileSync(arg, 'utf8');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const first = line.split(/[,;\t]/)[0].trim();
    if (!first) continue;
    if (/^(symbol|ticker)$/i.test(first)) continue;
    if (first.startsWith('#') || first.startsWith('//')) continue;
    out.push(first.toUpperCase());
  }
  return [...new Set(out)];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}
function intArg(v, d) { return v == null ? d : Math.round(Number(v)); }
function floatArg(v, d) { return v == null ? d : Number(v); }
function fmt(n, dp) { return Number.isFinite(n) ? n.toFixed(dp) : '—'; }
function pct(n) { return Number.isFinite(n) ? (n * 100).toFixed(0) + '%' : '—'; }

function usage(code) {
  console.error(`Usage: node scripts/wheel_batch.js --tickers <csv-path-or-comma-list> [options]

Required:
  --tickers <path|csv>     CSV file path, or comma-separated tickers (e.g. AAPL,JNJ,MSFT)

Strike / DTE:
  --dte <n>                Days to expiry (default 37)
  --strike-otm <pct>       Strike % OTM as decimal (default 0.075 = 7.5%)
  --strike-incr <n>        Strike rounding increment $ (default 1.0)

Models:
  --paths <n>              Monte Carlo path count (default 5000)
  --horizon <n>            Markov forecast horizon in bars (default 30)
  --rf <pct>               Risk-free rate (decimal, default 0.045 = 4.5%)
  --iv <pct>               Override implied vol (decimal annualized; default = realized vol)

Position sizing (optional):
  --account <$>            Account size for contract sizing (e.g. 25000)
  --max-pos <pct>          Max % of account per position (default 0.10)

Output:
  --out <path>             Write markdown to file (default: stdout)
  --concurrency <n>        Parallel tickers (default 4)
  --verbose                Log progress to stderr
  --help                   This help
`);
  process.exit(code);
}
