# `wheel_batch.js` — Technical Reference

Pure-Node Wheel Strategy batch scanner. Reads a list of tickers, fetches OHLCV
from Yahoo Finance, computes a comprehensive three-layer score + full options
trading math, and writes a markdown report with ready-to-place order specs.

No TradingView required. Cron-friendly. Single-file implementation.

---

## What it does (in one paragraph)

For each ticker in your list, the script fetches ~252 trading days of OHLCV from
Yahoo Finance's free chart API, computes a 4-criterion technical screen
(Bollinger / SMA50 / RSI / gap), classifies the current market regime, builds a
4×4 Markov transition matrix from the trailing 252-day regime history and
projects it `horizon` days ahead, runs a Monte Carlo GBM simulation against a
candidate strike to estimate assignment risk, layers a behavioral signal
(capitulation / failed-gap / trap-gap / round-number anchor) on top, prices the
put theoretically via Black-Scholes, and outputs a ranked markdown report with
every parameter a retail trader needs to place a cash-secured put — strike,
DTE, target credit, delta, break-even, max profit/loss, POP, expected value,
Kelly fraction, Greeks, position sizing.

---

## Architecture

```
scripts/
├── wheel_batch.js         ← orchestrator (this file's subject)
├── markov_regime.js       ← Markov matrix + horizon projection (spawned as subprocess)
├── monte_carlo_strike.js  ← GBM + bootstrap MC (spawned as subprocess)
└── behavioral_score.js    ← composite verdict ladder (spawned as subprocess)
```

`wheel_batch.js` owns:
- Yahoo Finance OHLCV fetch
- Technical scoring (BB / SMA / RSI / gap)
- Per-bar regime classification (port of `RegimeClassifier.pine` logic)
- Behavioral signal computation (port of `BehavioralOverlay.pine` logic)
- Black-Scholes pricer + Greeks
- POP estimation from MC percentiles
- Trade economics (EV, Kelly, annualized RoR, break-even)
- Position sizing
- Markdown report generation

The three sub-scripts handle the heavy mathematical layers and are unchanged
from the previous `/wheel-scan` design. They take JSON in and produce JSON out.

---

## Data source

**Yahoo Finance free chart API:**
`https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1y&interval=1d`

- No API key required.
- Returns 1 year of daily OHLCV.
- Handles US equities, ETFs, indices, futures (`ES=F`), crypto (`BTC-USD`).
- No rate limit advertised but the script caps concurrency at 4 by default.

If Yahoo is down or blocks you, swap `fetchYahooBars()` for any alternate source
(Alpha Vantage, Polygon, Tiingo) — the rest of the pipeline is data-source-agnostic.

---

## CLI reference

```
node scripts/wheel_batch.js --tickers <path|csv> [options]
```

### Required

| Flag | Description |
|---|---|
| `--tickers <arg>` | CSV file path (one ticker per row) OR comma-separated list like `AAPL,JNJ,MSFT` |

### Strike / DTE

| Flag | Default | Description |
|---|---|---|
| `--dte <n>` | `37` | Days to expiry, used for MC simulation horizon and BS pricing |
| `--strike-otm <pct>` | `0.075` | Strike % out-of-the-money as decimal (`0.075` = 7.5%, ~25Δ proxy) |
| `--strike-incr <n>` | `1.0` | Strike rounding increment in dollars |

### Models

| Flag | Default | Description |
|---|---|---|
| `--paths <n>` | `5000` | Monte Carlo simulation path count (more = slower + more precise) |
| `--horizon <n>` | `30` | Markov forecast horizon in trading days |
| `--rf <pct>` | `0.045` | Risk-free annual rate (decimal) for Black-Scholes |
| `--iv <pct>` | _realized vol_ | Override implied vol (decimal annualized). Defaults to 30d realized vol from log-returns |

### Position sizing (optional)

| Flag | Default | Description |
|---|---|---|
| `--account <$>` | _none_ | Account size in dollars; enables contract-count sizing |
| `--max-pos <pct>` | `0.10` | Maximum % of account per position (decimal) |

### Output

| Flag | Default | Description |
|---|---|---|
| `--out <path>` | _stdout_ | Write the markdown report to a file |
| `--concurrency <n>` | `4` | Parallel ticker scanning |
| `--verbose` | off | Log per-ticker progress to stderr |
| `--help` | — | Print usage |

---

## CSV format

Plain text, one ticker per row. The parser is forgiving:

- Optional header `symbol` or `ticker` is auto-skipped (case-insensitive)
- Lines starting with `#` or `//` are treated as comments
- First column only (split on `,`, `;`, or `\t`)
- Tickers are uppercased and deduplicated
- Blank lines ignored

Example (`scans/wheel_universe.csv`):

```
symbol
AAPL
MSFT
JNJ
# IT names
NVDA
AMD
```

You can also pass a comma list inline with no file:
```
--tickers AAPL,JNJ,MSFT
```

---

## Output structure

Markdown report with:

1. **Header** — date, scan parameters
2. **Tier summary table** — count per verdict
3. **ENTER_STRONG / ENTER / WATCH sections** — full trade block per ticker
4. **SKIP table** — one row per skipped ticker with reason
5. **Errors section** — tickers that failed to fetch / score

### Per-ticker block (ENTER tier and up)

Each block contains:

- **Snapshot** — spot, RSI, BB%, regime, realized vol
- **ORDER table** — ticker, strike, DTE, target credit (BS theoretical), delta, cash required, position size
- **Win/Loss math table** — POP, P(assignment), P(touch), break-even, max profit, max loss, E[loss|assign], EV/trade, annualized RoR, Kelly fraction
- **Greeks table** — Δ, Θ, V, Γ at the recommended strike
- **Verdict evidence** — the four scoring layers + composite formula
- **Execution checklist** — IV / spread / OI / delta-cross-check / order entry tactics

---

## The three-layer scoring model

### Layer 1 — Technical (0–4 score)

Each criterion contributes 1 point:

| Criterion | Pass condition |
|---|---|
| `bbPass` | `BB%` ≤ 0.25 (price in bottom quartile of Bollinger Band) |
| `smaPass` | `close < SMA50` OR `close > SMA50` for ≥ 72 consecutive bars |
| `rsiPass` | `RSI(14)` ≤ 60. Strong if ≤ 30. Auto-fail if > 70 |
| `gapPass` | No bar in last 30 days with `|open - prev_close| / prev_close ≥ 0.10` |

### Layer 2 — Markov regime forecast

State encoding (must match `RegimeClassifier.pine` historically):

| Code | State | Wheel-friendly |
|---|---|---|
| 0 | TREND_DOWN | ✗ |
| 1 | VOLATILE | ✗ |
| 2 | RANGE | ✓ |
| 3 | TREND_UP | ✓ |

Classification per bar uses SMA50 / RSI / BB% / ATR-vs-60bar-median. The full
252-bar regime series is fed to `markov_regime.js`, which:

1. Counts state transitions with Laplace smoothing (α=1)
2. Normalizes rows → 4×4 transition matrix `P`
3. Raises to `P^horizon` (default `^30`) via repeated multiplication
4. Reads the row for the current state → distribution over future states
5. `p_favorable = P(TREND_UP) + P(RANGE)`
6. Gates: if `p_favorable < 0.50` → verdict is forced to `SKIP_REGIME`

### Layer 3 — Monte Carlo GBM

`monte_carlo_strike.js` runs:

- `paths` simulations of `S_{t+1} = S_t · exp((μ − σ²/2)·dt + σ·√dt · Z)`
- `μ` and `σ` from 30-day log-returns of historical bars
- Tracks terminal price and path minimum per path
- `p_assign` = fraction of paths with terminal < strike
- `p_touch` = fraction of paths where min ≤ strike
- `E[loss|assign]` = mean loss across assigned paths
- Terminal percentiles: 5 / 50 / 95

**MC downgrade rule:** if `p_assign > 0.40`, the verdict is knocked one tier
(ENTER_STRONG → ENTER → WATCH → SKIP). This catches cases where the technical
+ Markov score is favorable but the chosen strike is too risky.

### Composite verdict

```
regimeAdj  = baseScore (0..4) × p_favorable (0..1)
finalScore = regimeAdj + behavioral_adj  (range: -2..+6)

verdict ladder (before MC downgrade):
  p_favorable < 0.5  →  SKIP_REGIME
  finalScore ≥ 4.5   →  ENTER_STRONG
  finalScore ≥ 3.0   →  ENTER
  finalScore ≥ 1.5   →  WATCH
  else               →  SKIP
```

### Behavioral signals (range -2 to +2)

Per `BehavioralOverlay.pine` logic:

| Signal | Trigger | Adj |
|---|---|---|
| Capitulation | volZ ≥ 2.0 AND RSI ≤ 30 AND green bar | +1.0 |
| Failed gap | gap-down ≥ 3% AND close > open | +0.5 |
| Trap gap | gap-down ≥ 3% AND close ≤ open | -1.0 |
| Anchor | spot within 0.5% of $5/$10/$50 round | +0.5 |

---

## Black-Scholes & Greeks

Standard formulas (continuous compounding, no dividend):

```
d1 = [ ln(S/K) + (r + σ²/2)·T ] / (σ·√T)
d2 = d1 - σ·√T
Put price = K·e^(-rT)·N(-d2) - S·N(-d1)

Δ (delta)  = -N(-d1)
Θ (theta)  = [ -S·n(d1)·σ / (2·√T) + r·K·e^(-rT)·N(-d2) ] / 365     // $ per day
V (vega)   = S·n(d1)·√T / 100                                        // $ per 1% IV move
Γ (gamma)  = n(d1) / (S·σ·√T)
```

- `T` = DTE / 365
- `σ` = `--iv` if provided, else 30d realized vol annualized
- `r` = `--rf` (default 0.045)
- `N(·)` = standard-normal CDF (Abramowitz-Stegun 26.2.17, error < 1.5e-7)
- `n(·)` = standard-normal PDF

---

## Trade economics — formulas

| Metric | Formula | Meaning |
|---|---|---|
| Credit per contract | `bs_price × 100` | What you collect for selling 1 put |
| Break-even | `strike - bs_price` | Below this at expiry = losing trade |
| Max profit | `bs_price × 100` | Keep full credit if expires OTM |
| Max loss | `(strike - bs_price) × 100` | Worst case: stock → $0 |
| Cash required | `strike × 100` | Cash-secured margin per contract |
| **EV / trade** | `credit·(1-p_assign) - E[loss\|assign]·p_assign·100` | Long-run dollar expectation per contract |
| Annualized RoR | `(premium/strike) × (365/DTE)` | Uncompounded annualized return on margin |
| **POP** | `1 - CDF(break-even)` via MC percentiles | True probability of profit (terminal > break-even) |
| Kelly fraction | `(b·p - (1-p)) / b` where `b = credit/loss, p = win_prob` | Optimal % of risk capital |

### Position sizing

If `--account <$>` is provided:

```
contracts = floor((account × max_pos_pct) / (strike × 100))
```

Reports `0 contracts` if your per-position cap can't cover one contract of
cash-secured margin — that's a real constraint, not a bug.

---

## POP estimation method

`monte_carlo_strike.js` returns terminal percentiles at p5/p50/p95. To get POP:

1. Treat the three points as samples of the inverse CDF
2. Linearly interpolate between adjacent points to find `CDF(break-even)`
3. POP = `1 - CDF(break-even)`

If break-even is below p5 or above p95, clamps to 0.95 or 0.05 respectively.
Less precise than counting MC paths directly, but the percentile-only output
keeps `monte_carlo_strike.js` cheap. For higher precision, raise `--paths`.

---

## Realized vs implied vol

Default `σ` is **30-day realized vol annualized** (`stdev(log_returns_last_30) × √252`).

In live trading, the option chain's implied vol is what determines the actual
premium you receive. The script's Black-Scholes price is what's _theoretically
fair_ given realized vol. Two consequences:

1. **Compare actual delta in ToS vs `Δ (BS)`** — if they differ by >5pp, IV
   skew is meaningful and the actual premium will be higher than the BS
   theoretical credit. Re-run with `--iv <annualized>` matching the ATM IV.
2. **Treat the BS credit as a floor, not a target** — if the real bid is below
   the BS price, the market is implying lower vol than the underlying has
   actually delivered. That's a worse-than-fair quote; consider skipping.

---

## Known limitations

- **Yahoo data quality** — occasionally has missing or split-unadjusted bars.
  The script drops `null` OHLC entries silently. Verify with TV if a ticker
  reports suspicious vol.
- **No option chain integration** — script can't see real IV, strikes, OI, or
  spreads. All option pricing is BS theoretical. The execution checklist makes
  this explicit ("verify IV is 30–60%", "compare delta in ToS").
- **GBM assumption** — assumes lognormal returns. Heavy-tailed names (meme
  stocks, biotech binary events) will have higher real assignment risk than
  the MC reports. The bootstrap method in `monte_carlo_strike.js` preserves
  fat tails but isn't currently exposed in the report; raise the issue if you
  want it added.
- **No earnings calendar** — script doesn't know about earnings. A high-POP
  trade through an earnings date is a different beast. Manual override needed.
- **Regime classifier rules are heuristic** — calibrated to liquid US equities.
  Crypto, low-priced stocks, and indices may classify oddly.

---

## Maintenance

| To change | Edit |
|---|---|
| The verdict thresholds | `verdictBase` switch in `wheel_batch.js` |
| MC downgrade threshold | `mcDowngradeAt` constant — currently hardcoded `0.40` in `downgradeForMC()` |
| Behavioral signal weights | `computeBehavioralAdj()` |
| Regime classification rules | `classifyRegimeSeries()` |
| Output format | `renderReport()` and `renderTickerBlock()` |
| Data source | `fetchYahooBars()` — swap to any provider returning bars |

When you change scoring logic, also update `pine/WheelTriple.pine` so the
on-chart indicator stays in sync with the batch scanner.

---

## Related files

- `pine/WheelTriple.pine` — on-chart equivalent (same math, visual scorer)
- `scripts/markov_regime.js` — Markov subprocess
- `scripts/monte_carlo_strike.js` — MC subprocess
- `scripts/behavioral_score.js` — verdict ladder subprocess
- `docs/GUIDE.md` — quick-start user guide (start here if you've never run this)
- `scans/wheel_universe.csv` — default ticker list (edit this for your watchlist)
