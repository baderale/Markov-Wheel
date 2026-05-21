#!/usr/bin/env node
// Markov regime engine for the Wheel Strategy.
//
// Reads a historical sequence of integer regime states (0/1/2/3, as produced by
// RegimeClassifier.pine), fits a 4×4 transition matrix with Laplace smoothing,
// and computes the 30-day-ahead state distribution from the current state.
//
// State encoding (must match RegimeClassifier.pine):
//   0 = TREND_DOWN  (bearish, avoid wheel)
//   1 = VOLATILE    (high ATR)
//   2 = RANGE       (sideways, wheel-friendly)
//   3 = TREND_UP    (bullish, wheel-friendly)
//
// Usage:
//   node scripts/markov_regime.js --states-file states.json
//   echo '{"states":[3,3,2,2,2,...]}' | node scripts/markov_regime.js --stdin
//   node scripts/markov_regime.js --states-file states.json --horizon 45 --laplace 1
//
// states.json shape: { "states": [3, 3, 2, 2, 2, 1, 0, ...] } where the last
// element is the current regime.
//
// Output: single-line JSON with current regime, transition matrix, 30-day
// distribution, P(favorable_30d), and a stability score.

import { readFileSync, readSync as fsReadSync } from 'fs';

const STATE_NAMES = ['TREND_DOWN', 'VOLATILE', 'RANGE', 'TREND_UP'];
const N_STATES = 4;

// ─── Args ─────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);

const HORIZON = Math.max(1, Math.round(num(args.horizon ?? 30, '--horizon')));
const LAPLACE = num(args.laplace ?? 1, '--laplace');

// ─── Load states ──────────────────────────────────────────────────────────
let raw;
if (args.stdin) {
  raw = readStdin();
} else if (args['states-file']) {
  raw = readFileSync(args['states-file'], 'utf8');
} else {
  console.error('error: pass --states-file <path> or --stdin');
  usage(1);
}

const states = extractStates(JSON.parse(raw));
if (states.length < 30) {
  console.error(`error: need >=30 states for stable transition matrix, got ${states.length}`);
  process.exit(2);
}

// ─── Transition matrix with Laplace smoothing ─────────────────────────────
const counts = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(LAPLACE));
for (let i = 1; i < states.length; i++) {
  const from = states[i - 1];
  const to = states[i];
  if (from < 0 || from >= N_STATES || to < 0 || to >= N_STATES) continue;
  counts[from][to] += 1;
}
const P = counts.map(row => {
  const sum = row.reduce((a, b) => a + b, 0);
  return row.map(c => c / sum);
});

// ─── Current state → 30-day distribution ──────────────────────────────────
const current = states[states.length - 1];
const P_n = matrixPow(P, HORIZON);
const dist = P_n[current]; // row `current` is the distribution at horizon

// favorable = TREND_UP (3) + RANGE (2)
const pFavorable = dist[3] + dist[2];

// Stability = trace(P) / N. Higher = states persist longer.
const stability = P.reduce((s, row, i) => s + row[i], 0) / N_STATES;

// Expected dwell time in current state ≈ 1 / (1 - P[i][i])
const dwell = 1 / Math.max(1e-6, 1 - P[current][current]);

const result = {
  inputs: {
    n_states_observed: states.length,
    horizon_days: HORIZON,
    laplace_alpha: LAPLACE,
    current_state: current,
    current_state_name: STATE_NAMES[current],
  },
  transition_matrix: P.map(row => row.map(x => round(x, 4))),
  state_names: STATE_NAMES,
  horizon_distribution: {
    TREND_DOWN: round(dist[0], 4),
    VOLATILE: round(dist[1], 4),
    RANGE: round(dist[2], 4),
    TREND_UP: round(dist[3], 4),
  },
  p_favorable_horizon: round(pFavorable, 4),
  p_unfavorable_horizon: round(dist[0] + dist[1], 4),
  current_state_persistence: round(P[current][current], 4),
  expected_dwell_days: round(dwell, 2),
  stability_score: round(stability, 4),
  wheel_gate: pFavorable >= 0.5 ? 'PASS' : 'SKIP',
};

console.log(JSON.stringify(result));

// ═══════════════════════════════════════════════════════════════════════════
function extractStates(obj) {
  if (Array.isArray(obj)) return obj.map(toInt).filter(s => s >= 0);
  if (Array.isArray(obj?.states)) return obj.states.map(toInt).filter(s => s >= 0);
  if (Array.isArray(obj?.values)) return obj.values.map(toInt).filter(s => s >= 0);
  throw new Error('could not find states[] in input; expected top-level array, .states, or .values');
}

function toInt(x) {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n >= 0 && n < N_STATES ? n : -1;
}

function matrixMul(A, B) {
  const n = A.length;
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += a * B[k][j];
    }
  }
  return C;
}

function matrixPow(P, n) {
  // Exponentiation by squaring.
  let result = Array.from({ length: P.length }, (_, i) =>
    P.map((_, j) => (i === j ? 1 : 0)));
  let base = P.map(row => row.slice());
  let exp = n;
  while (exp > 0) {
    if (exp & 1) result = matrixMul(result, base);
    base = matrixMul(base, base);
    exp >>= 1;
  }
  return result;
}

function round(x, d) {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
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
  markov_regime.js (--states-file <path> | --stdin) [--horizon 30] [--laplace 1]

Input JSON: { "states": [3, 3, 2, 2, 1, 0, ...] }
  States encoded 0..3:  0=TREND_DOWN, 1=VOLATILE, 2=RANGE, 3=TREND_UP
  Last element is the current state.

Output JSON: { transition_matrix, horizon_distribution, p_favorable_horizon,
               stability_score, wheel_gate: PASS|SKIP }
`);
  process.exit(code);
}
