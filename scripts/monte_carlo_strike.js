#!/usr/bin/env node
// Monte Carlo strike-safety calculator for cash-secured puts.
//
// Runs GBM + bootstrap simulations against historical daily bars and reports
// P(assignment), P(touch), E[loss | assignment], and terminal percentiles for
// a given strike and DTE.
//
// Usage:
//   node scripts/monte_carlo_strike.js --strike 335 --dte 37 --bars-file bars.json
//   node scripts/monte_carlo_strike.js --strike 335 --dte 37 --bars-file bars.json --iv 0.42
//   cat bars.json | node scripts/monte_carlo_strike.js --strike 335 --dte 37 --stdin
//
// bars.json shape (matches mcp__tradingview__data_get_ohlcv with summary:false):
//   { "bars": [ { "time": ..., "open": ..., "high": ..., "low": ..., "close": ..., "volume": ... }, ... ] }
//   OR an array of bars at the top level
//   OR { "data": { "bars": [...] } }
//
// Output: single-line JSON suitable for the /wheel-scan orchestrator to splice
// into its enriched ranking table.

import { readFileSync, readSync as fsReadSync } from 'fs';

// ─── Arg parsing ──────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (args.strike == null || args.dte == null) {
  console.error('error: --strike and --dte are required');
  usage(1);
}

const STRIKE = num(args.strike, '--strike');
const DTE = Math.max(1, Math.round(num(args.dte, '--dte')));
const PATHS = Math.max(100, Math.round(num(args.paths ?? 10000, '--paths')));
const IV_OVERRIDE = args.iv != null ? num(args.iv, '--iv') : null;
const SEED = args.seed != null ? Math.round(num(args.seed, '--seed')) : null;

// ─── Load bars ────────────────────────────────────────────────────────────
let raw;
if (args.stdin) {
  raw = readStdin();
} else if (args['bars-file']) {
  raw = readFileSync(args['bars-file'], 'utf8');
} else {
  console.error('error: pass --bars-file <path> or --stdin');
  usage(1);
}

const bars = extractBars(JSON.parse(raw));
if (bars.length < 30) {
  console.error(`error: need >=30 bars for stable stats, got ${bars.length}`);
  process.exit(2);
}

// Closes only — MC operates on log returns.
const closes = bars.map(b => b.close).filter(x => Number.isFinite(x) && x > 0);
if (closes.length < 30) {
  console.error(`error: bars contained <30 valid closes`);
  process.exit(2);
}

const spot = closes[closes.length - 1];
const lowConfidence = closes.length < 252;

// ─── Empirical drift + vol from log returns ───────────────────────────────
const logRets = [];
for (let i = 1; i < closes.length; i++) {
  logRets.push(Math.log(closes[i] / closes[i - 1]));
}
const mu = mean(logRets);                     // daily drift
const sigmaRealized = stdev(logRets, mu);     // daily realized vol
const sigma = IV_OVERRIDE != null
  ? IV_OVERRIDE / Math.sqrt(252)              // annualized IV → daily
  : sigmaRealized;

// ─── Simulations ──────────────────────────────────────────────────────────
const rng = SEED != null ? mulberry32(SEED >>> 0) : Math.random;

const gbm = simulateGBM({ spot, mu, sigma, dte: DTE, paths: PATHS, rng });
const boot = simulateBootstrap({ spot, logRets, dte: DTE, paths: PATHS, rng });

// ─── Output ──────────────────────────────────────────────────────────────
const result = {
  inputs: {
    spot: round(spot, 4),
    strike: STRIKE,
    dte: DTE,
    paths: PATHS,
    bars_used: closes.length,
    daily_drift: round(mu, 6),
    daily_vol_realized: round(sigmaRealized, 6),
    daily_vol_used: round(sigma, 6),
    iv_override_annualized: IV_OVERRIDE,
    low_confidence: lowConfidence,
  },
  gbm: summarize(gbm, STRIKE),
  bootstrap: summarize(boot, STRIKE),
};

console.log(JSON.stringify(result));

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

function simulateGBM({ spot, mu, sigma, dte, paths, rng }) {
  const drift = (mu - 0.5 * sigma * sigma);
  const terminals = new Float64Array(paths);
  const pathMins = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    let s = spot;
    let lo = spot;
    for (let t = 0; t < dte; t++) {
      const z = gauss(rng);
      s = s * Math.exp(drift + sigma * z);
      if (s < lo) lo = s;
    }
    terminals[p] = s;
    pathMins[p] = lo;
  }
  return { terminals, pathMins };
}

function simulateBootstrap({ spot, logRets, dte, paths, rng }) {
  const n = logRets.length;
  const terminals = new Float64Array(paths);
  const pathMins = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    let s = spot;
    let lo = spot;
    for (let t = 0; t < dte; t++) {
      const r = logRets[Math.floor(rng() * n)];
      s = s * Math.exp(r);
      if (s < lo) lo = s;
    }
    terminals[p] = s;
    pathMins[p] = lo;
  }
  return { terminals, pathMins };
}

function summarize({ terminals, pathMins }, strike) {
  let assignCount = 0;
  let touchCount = 0;
  let lossSum = 0;
  for (let i = 0; i < terminals.length; i++) {
    if (terminals[i] < strike) {
      assignCount++;
      lossSum += (strike - terminals[i]);
    }
    if (pathMins[i] <= strike) touchCount++;
  }
  const sortedTerm = Float64Array.from(terminals).sort();
  return {
    p_assign: round(assignCount / terminals.length, 4),
    p_touch: round(touchCount / terminals.length, 4),
    e_loss_given_assign: assignCount > 0 ? round(lossSum / assignCount, 4) : 0,
    terminal_pct: {
      p5: round(quantile(sortedTerm, 0.05), 4),
      p25: round(quantile(sortedTerm, 0.25), 4),
      p50: round(quantile(sortedTerm, 0.50), 4),
      p75: round(quantile(sortedTerm, 0.75), 4),
      p95: round(quantile(sortedTerm, 0.95), 4),
    },
  };
}

// ─── Stat helpers ─────────────────────────────────────────────────────────
function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function stdev(xs, m) {
  let s = 0;
  for (const x of xs) { const d = x - m; s += d * d; }
  return Math.sqrt(s / (xs.length - 1));
}
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function round(x, d) {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

// Box-Muller standard normal
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Seedable PRNG for deterministic test output.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── IO helpers ───────────────────────────────────────────────────────────
function extractBars(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.bars)) return obj.bars;
  if (Array.isArray(obj?.data?.bars)) return obj.data.bars;
  if (Array.isArray(obj?.result?.bars)) return obj.result.bars;
  if (Array.isArray(obj?.ohlcv)) return obj.ohlcv;
  throw new Error('could not find bars[] in input JSON; expected one of: top-level array, .bars, .data.bars, .result.bars, .ohlcv');
}

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let n;
    try { n = fsReadSync(0, buf, 0, buf.length, null); }
    catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
    if (!n) break;
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else if (a.startsWith('-')) {
      out[a.slice(1)] = true;
    }
  }
  return out;
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`error: ${name} must be numeric, got ${JSON.stringify(v)}`);
    process.exit(1);
  }
  return n;
}

function usage(code) {
  console.error(`Usage:
  monte_carlo_strike.js --strike <K> --dte <days> [--bars-file <path> | --stdin]
                        [--iv <annualized>] [--paths 10000] [--seed N]

Outputs JSON: { inputs, gbm: {p_assign, p_touch, e_loss_given_assign, terminal_pct},
                bootstrap: {...} }
`);
  process.exit(code);
}
