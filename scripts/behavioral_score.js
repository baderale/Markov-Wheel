#!/usr/bin/env node
// Behavioral scoring for the /wheel-scan enrichment pipeline.
//
// Combines:
//   - base technical score from WheelScreener.pine (0..4)
//   - p_favorable_horizon from markov_regime.js (0..1)
//   - behavioral adjustment from BehavioralOverlay.pine (-2..+2)
//
// Outputs the final composite score and a verdict.
//
// Usage:
//   node scripts/behavioral_score.js --base 4 --p-favorable 0.62 --behavioral 0.5
//   echo '{"base":4,"p_favorable":0.62,"behavioral":0.5}' | node scripts/behavioral_score.js --stdin
//   node scripts/behavioral_score.js --behavioral-file overlay.json --base 4 --p-favorable 0.62
//
// behavioral-file shape (data_get_study_values response): expects the last
// value of the "Behavioral adj" plot. The script extracts it automatically.

import { readFileSync, readSync as fsReadSync } from 'fs';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);

let payload = null;
if (args.stdin) {
  payload = JSON.parse(readStdin());
} else if (args['behavioral-file']) {
  payload = JSON.parse(readFileSync(args['behavioral-file'], 'utf8'));
}

const baseScore = num(args.base, '--base');
const pFavorable = args['p-favorable'] != null
  ? num(args['p-favorable'], '--p-favorable')
  : 1.0;
let behavioral = args.behavioral != null
  ? num(args.behavioral, '--behavioral')
  : extractBehavioralAdj(payload);

if (behavioral == null) {
  console.error('error: pass --behavioral <num>, --behavioral-file <path>, or --stdin with payload');
  usage(1);
}

if (baseScore < 0 || baseScore > 4) {
  console.error(`error: --base must be in [0,4], got ${baseScore}`);
  process.exit(1);
}
if (pFavorable < 0 || pFavorable > 1) {
  console.error(`error: --p-favorable must be in [0,1], got ${pFavorable}`);
  process.exit(1);
}

// Clamp behavioral defensively.
behavioral = Math.max(-2, Math.min(2, behavioral));

// Final composite:
//   regime-gated technical score, then behavioral bias.
//   Max possible = 4 * 1.0 + 2 = 6.   Min = 0 * 0 - 2 = -2.
const regimeAdjusted = baseScore * pFavorable;
const final = regimeAdjusted + behavioral;

let verdict;
if (pFavorable < 0.5) {
  verdict = 'SKIP_REGIME';
} else if (final >= 4.5) {
  verdict = 'ENTER_STRONG';
} else if (final >= 3.0) {
  verdict = 'ENTER';
} else if (final >= 1.5) {
  verdict = 'WATCH';
} else {
  verdict = 'SKIP';
}

const result = {
  base_score: baseScore,
  p_favorable_horizon: pFavorable,
  behavioral_adj: round(behavioral, 3),
  regime_adjusted: round(regimeAdjusted, 3),
  final_score: round(final, 3),
  final_score_max: 6.0,
  verdict,
};

console.log(JSON.stringify(result));

// ═══════════════════════════════════════════════════════════════════════════
function extractBehavioralAdj(obj) {
  if (obj == null) return null;
  // Direct: { behavioral_adj: 0.5 } or { behavioral: 0.5 } or { adj: 0.5 }
  if (typeof obj.behavioral_adj === 'number') return obj.behavioral_adj;
  if (typeof obj.behavioral === 'number') return obj.behavioral;
  if (typeof obj.adj === 'number') return obj.adj;

  // data_get_study_values response: look for the "Behavioral adj" plot.
  const studies = obj.studies ?? obj.data?.studies ?? obj.result?.studies;
  if (Array.isArray(studies)) {
    for (const s of studies) {
      const plots = s.plots ?? s.values ?? [];
      const arr = Array.isArray(plots) ? plots : Object.entries(plots).map(([k, v]) => ({ name: k, value: v }));
      for (const p of arr) {
        const name = (p.name ?? p.title ?? '').toString().toLowerCase();
        if (name.includes('behavioral adj') || name === 'adj') {
          const v = p.value ?? p.last ?? p.current;
          if (typeof v === 'number') return v;
        }
      }
    }
  }
  return null;
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
  if (v === true || v == null) {
    console.error(`error: ${name} requires a value`);
    process.exit(1);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`error: ${name} must be numeric, got ${JSON.stringify(v)}`);
    process.exit(1);
  }
  return n;
}

function usage(code) {
  console.error(`Usage:
  behavioral_score.js --base <0..4> --p-favorable <0..1>
                      (--behavioral <-2..+2> | --behavioral-file <path> | --stdin)

Output: { base_score, p_favorable_horizon, behavioral_adj, regime_adjusted,
          final_score, final_score_max: 6, verdict }

verdict: ENTER_STRONG (>=4.5) | ENTER (>=3.0) | WATCH (>=1.5) | SKIP | SKIP_REGIME
`);
  process.exit(code);
}
