# Markov-Wheel

**A quantitative scanner for the Wheel options strategy.**
Feed it a list of tickers — get back a ranked trade sheet with strike, DTE, target credit, win rate, expected value, Greeks, and position sizing for cash-secured puts.

Pure Node.js. No TradingView account, no broker API, no API keys. Runs in seconds against a public market-data feed.

---

## What problem this solves

The Wheel Strategy (sell cash-secured puts → if assigned, sell covered calls → repeat) has a long literature behind it but a tedious daily routine:
read the chart, check the indicators, eyeball the implied vol, pick a strike, estimate assignment risk, do the back-of-envelope math on premium-vs-tail-loss, compare across 10+ tickers. **Markov-Wheel does that in one command.**

It scores every ticker through **three independent statistical models** that must all agree before a trade is recommended:

| Layer | Question it answers | How |
|---|---|---|
| **Technical** | Is the setup mechanically right now? | Bollinger Band position, SMA50 trend, RSI, gap history |
| **Markov chain** | Will the regime stay favorable for the next ~30 days? | 4-state regime model (TREND_DOWN / VOLATILE / RANGE / TREND_UP), 252-bar transition matrix, projected forward `P^horizon` |
| **Monte Carlo** | What's the assignment risk at the recommended strike? | 5,000-path Geometric Brownian Motion simulation over the DTE window, drift + vol from realized log returns |

A **behavioral overlay** (capitulation, failed-gap reversals, trap gaps, round-number anchors) adds or subtracts conviction.

Then on top of that, **Black-Scholes** prices the put theoretically and computes:

- Probability of Profit (POP)
- Expected Value per trade ($)
- Annualized return on margin
- Kelly fraction (optimal sizing)
- Greeks (delta, theta, vega, gamma)
- Break-even, max profit, max loss
- Position sizing based on your account

---

## What the output looks like

Run:

```bash
node scripts/wheel_batch.js --tickers scans/wheel_universe.csv --account 25000
```

Get back a ranked markdown report. A single ticker block:

```
JNJ — ENTER · score 3.15/6.00
Snapshot: spot $229.32 · RSI 50.1 · BB% 71% · regime RANGE · realized σ 18%

ORDER — Sell cash-secured put
Ticker           JNJ
Strike           $212.00  (7.4% OTM)
DTE              37 days
Target credit    $0.44/share = $44/contract
Delta (BS)       -0.07 (~7Δ)
Cash required    $21,200 per contract
Position size    1 contract  (10% of $25,000)

Win / Loss math
POP (probability of profit)        95%      Terminal > break-even
P(no assignment)                   98%      Keep full credit
P(assignment)                      2%       Forced to buy 100 shares
Break-even price                   $211.56
Max profit                         $44/contract
Max loss                           $21,156/contract  (if stock → $0)
Expected loss if assigned          $436/contract
Expected value per trade           +$36.17/contract
Annualized RoR                     2%
Kelly fraction                     88%

Greeks: Δ -0.073 · Θ -$0.023/day · V $0.101/1%IV · Γ 0.0103
```

That's the order. Type it into your broker.

---

## What makes this different from "another wheel screener"

Most wheel screeners stop at "RSI is low, BB% is low → ENTER." That misses two things:

1. **Regime context.** A picture-perfect technical setup in a trending-down regime is still a losing trade. The Markov layer kills trades where the forward regime distribution favors continued weakness, even if today looks oversold.

2. **The strike actually matters.** "ENTER" doesn't tell you _which_ strike. Markov-Wheel runs a Monte Carlo at the recommended strike, computes the actual assignment probability, and **automatically downgrades the verdict if assignment risk exceeds 40%**. You can have a 4/4 technical setup and still get knocked from ENTER to SKIP because the chosen strike is too aggressive.

The result: **Expected Value is the truth-teller.** Many screeners surface 70%+ POP trades that are negative-EV — the credit you collect doesn't cover the modeled tail loss. Markov-Wheel makes this explicit. A typical 15-ticker scan might produce 2 verdict-ENTER tickers but only **1 with positive EV**. The math is honest about that.

---

## Quick start

```bash
git clone https://github.com/baderale/Markov-Wheel.git
cd Markov-Wheel

# Test it on three tickers (no setup needed — Node 18+ has fetch built-in)
node scripts/wheel_batch.js --tickers AAPL,JNJ,MSFT

# Use the included sample watchlist (edit scans/wheel_universe.csv to your own picks)
node scripts/wheel_batch.js --tickers scans/wheel_universe.csv

# Daily scan, with your account size, saved to a dated file
node scripts/wheel_batch.js \
  --tickers scans/wheel_universe.csv \
  --account 25000 \
  --out scans/$(date +%F)_wheel-batch.md
```

**Full options:** `node scripts/wheel_batch.js --help`

---

## Reading the output (3 things matter most)

1. **Expected Value (EV) is the gatekeeper.** Negative EV = don't trade, regardless of POP or verdict.
2. **POP (Probability of Profit)** is your real win rate — what % of simulated paths end above your break-even.
3. **Position size** tells you the contract count that fits within your account cap. `0 contracts` means the trade is too capital-intensive for your account at the cap you set (default 10%) — adjust `--max-pos` or pick lower-priced underlyings.

Worked walkthrough → [docs/GUIDE.md](docs/GUIDE.md)
Every flag and formula → [docs/REFERENCE.md](docs/REFERENCE.md)

---

## Optional: on-chart Pine indicator

`pine/WheelTriple.pine` is the same math, rendered as a TradingView v6 indicator with a dashboard table and forward Monte Carlo bands. Paste it into the Pine Editor for visual confirmation of a single ticker. The batch scanner is the production tool; the Pine indicator is the visual second-opinion.

---

## Data source

OHLCV bars come from Yahoo Finance's free chart API (no key, no signup). 1-year of daily bars per ticker. Cached implicitly by the OS; no rate limiting issues at typical watchlist sizes (~15 tickers).

If you have an institutional data source (Polygon, Tiingo, Refinitiv, etc.), swap `fetchYahooBars()` in `scripts/wheel_batch.js` — every downstream layer is data-source-agnostic.

---

## What this does NOT do

- **Does not place trades.** It outputs the order you should place. You place it.
- **Does not have option chain data.** All option pricing is Black-Scholes theoretical using realized vol as the IV proxy. Compare the script's delta to your broker's actual delta — if they diverge by >5pp, the IV skew is meaningful and you should pass `--iv <annualized>` matching the option chain's ATM IV.
- **Does not know about earnings.** A high-POP trade through an earnings date is a different risk profile. Check your earnings calendar.
- **Does not know about dividends.** BS pricing assumes no dividend.
- **Does not handle binary events** (biotech FDA dates, M&A votes). GBM assumes smooth diffusion.

---

## Project layout

```
markov-wheel/
├── scripts/
│   ├── wheel_batch.js          ← the scanner (this is what you run)
│   ├── markov_regime.js        ← Markov 4×4 transition matrix + projection
│   ├── monte_carlo_strike.js   ← GBM Monte Carlo simulator
│   └── behavioral_score.js     ← composite verdict ladder
├── pine/
│   └── WheelTriple.pine        ← optional on-chart equivalent
├── scans/
│   └── wheel_universe.csv      ← edit this with your tickers
├── docs/
│   ├── GUIDE.md                ← quick-start walkthrough
│   └── REFERENCE.md            ← every flag, every formula
├── README.md                   ← this file
├── LICENSE                     ← MIT
└── package.json
```

---

## Requirements

- **Node.js 18 or later** (uses built-in `fetch`)
- That's it. No npm install required.

---

## Disclaimer

**This is not financial advice.** This software is for educational and research purposes only. Options trading involves substantial risk of loss and is not suitable for every investor. The mathematical models in this tool are approximations of real market behavior — they will be wrong. Past performance does not predict future results.

- The author is not a registered investment advisor.
- The Black-Scholes model assumes log-normal returns, constant volatility, and continuous trading — none of which hold in reality.
- The Monte Carlo simulation does not account for IV crush around earnings, gap-down events outside the lookback window, dividend payments, early assignment risk on American-style options, or counterparty risk.
- The Markov regime classifier is heuristic and calibrated to liquid US equities.
- Expected Value calculations assume the GBM-modeled assignment loss is accurate. In tail-event environments (2008, March 2020, etc.) actual losses will exceed modeled losses substantially.

**You are solely responsible for your trades.** Verify every recommendation against your broker's actual option chain, your own due diligence, your tax situation, and your risk tolerance. If you are not comfortable losing the maximum loss shown for any given trade, do not place that trade.

---

## License

[MIT](LICENSE) — use, fork, modify, sell freely with attribution.

---

## Contributing

Issues and PRs welcome. Particularly interested in:
- Alternate data source integrations (Polygon, Tiingo, Alpha Vantage)
- Implied volatility / option chain integration (currently BS-theoretical only)
- Earnings calendar awareness
- Backtest harness against historical option chains
- Multi-leg strategy support (covered calls, jade lizard, strangle)

Keep the core philosophy: **three independent layers must agree before recommending a trade, and Expected Value is the gatekeeper.**
