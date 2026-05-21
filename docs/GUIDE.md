# Wheel Batch Scanner — Quick-Start Guide

Find good wheel-strategy trades across a list of tickers, in one command. No
TradingView, no API keys, no graph required.

> **For all the technical details (formulas, model assumptions, every CLI flag),
> read `docs/REFERENCE.md`. This guide just gets you running.**

---

## What it does

You give it a list of stock tickers. It tells you, for each one:

- **Should I sell a put on this?** (ENTER_STRONG / ENTER / WATCH / SKIP)
- **What strike and expiry?**
- **What's the win rate?** (POP)
- **How much will I make?** ($ credit + expected value)
- **How much could I lose?** (max loss + expected loss if assigned)
- **How many contracts can I afford?** (if you tell it your account size)

It runs every ticker through three independent models — technical analysis,
Markov regime forecasting, Monte Carlo simulation — plus Black-Scholes pricing,
and ranks the results best to worst.

---

## First-time setup

1. You already have Node.js installed (this project uses it).
2. No API keys, no installs, no logins. The script fetches market data from
   Yahoo Finance's free endpoint.
3. (Optional) Edit `scans/wheel_universe.csv` with your watchlist. Pre-populated
   with 15 tickers — change them to whatever you want.

That's it.

---

## Quick start (three commands)

### 1. Smoke test with three tickers

```
node scripts/wheel_batch.js --tickers AAPL,JNJ,MSFT
```

Prints a full report to your terminal. Takes ~10 seconds.

### 2. Run your full watchlist

```
node scripts/wheel_batch.js --tickers scans/wheel_universe.csv
```

### 3. Daily scan saved to file, with your account size

```
node scripts/wheel_batch.js \
  --tickers scans/wheel_universe.csv \
  --account 25000 \
  --out scans/2026-05-21_wheel-batch.md
```

Opens the report in your editor of choice — it's just markdown.

---

## Editing your watchlist

The file is at `scans/wheel_universe.csv`. Plain text, one ticker per line:

```
symbol
AAPL
MSFT
JNJ
JPM
NVDA
```

Rules:
- First line can be `symbol` or `ticker` — it gets skipped
- Lines starting with `#` are comments
- Blank lines OK
- US stocks, ETFs, indices all work

You can also skip the file entirely and pass tickers on the command line:

```
node scripts/wheel_batch.js --tickers AAPL,JNJ,MSFT,GOOGL
```

---

## Reading the output

Every report has these sections (in this order):

### 1. Tier summary

How many tickers landed in each verdict:

```
| Tier         | Count |
|--------------|-------|
| ENTER        | 2     |
| WATCH        | 5     |
| SKIP         | 7     |
| SKIP_REGIME  | 1     |
```

**The whole game is in the ENTER and ENTER_STRONG tiers.** Everything else is
"not today."

### 2. ENTER blocks (the trades worth taking)

Each ticker that earned ENTER or higher gets a full block with:

```
### JNJ — ENTER · score 3.15/6.00
```

The headline gives you: **ticker**, **verdict**, and the **composite score** out of 6.

#### The ORDER table — what to type into ThinkorSwim

```
Ticker            JNJ
Strike            $212.00   (8% OTM)
DTE               37 days
Target credit     $0.44/share = $44/contract
Delta             -0.07 (~7Δ)
Cash required     $21,200 per contract
Position size     1 contract  (10% of $25,000)
```

This is the order. Open the JNJ option chain in ToS, find the expiry closest to
37 days out, sell the put at strike $212, target the credit shown. If your
account is too small for full position size, the script will tell you "0
contracts" — that's not a bug, that's the math.

#### The Win / Loss math table — should you actually take it?

```
POP (probability of profit)    95%      ← The real win rate
P(no assignment)               98%      ← Expires worthless
P(assignment)                  2%       ← Forced to buy 100 shares
Break-even price               $211.56  ← Below this = losing trade
Max profit                     $44      ← Best case
Max loss                       $21,156  ← Worst case (stock → $0)
Expected loss if assigned      $436     ← Average $ loss on bad outcomes
Expected value per trade       +$36.17  ← The bottom line
Annualized RoR                 2%       ← Yearly return on capital
Kelly fraction                 80%      ← Optimal sizing if you trust the model
```

**The single most important number is Expected Value (EV).** If it's negative,
the trade loses money over the long run even if POP looks good. Skip negative-EV
trades regardless of what the verdict says.

**Second most important: POP.** Anything ≥85% means the math says it should
profit 8.5 times out of 10.

**Annualized RoR** lets you compare the trade to other uses of your capital
(savings, T-bills, other underlyings). 2% on JNJ vs 11% on MSFT is the wheel
strategy's risk premium showing.

#### The Greeks table — for tweaking later

```
Δ (delta)  Θ (theta/day)  V (vega/1%IV)  Γ (gamma)
-0.073     -$0.023/share  $0.101/share   0.0103
```

You don't need to act on these to place the trade. They're useful if you decide
to roll, close early, or adjust to a different strike.

- **Δ delta** — the option's sensitivity to a $1 move in the stock. Most
  traders pick wheel strikes by delta: ~25Δ ≈ 25% chance of assignment.
- **Θ theta** — how much premium you decay PER DAY. If theta is $0.023/share,
  that's $2.30/contract per day of decay working in your favor.
- **V vega** — how much premium changes per 1% IV change. Bigger vega = more
  exposed to volatility moves.
- **Γ gamma** — how fast delta changes when the stock moves. High gamma near
  expiry = your delta swings violently in the last week.

#### The Verdict evidence — why the verdict is what it is

Shows the three layers (technical, Markov, MC, behavioral) plus how they
combined into the composite score. Skim this if a verdict feels surprising.

#### The Execution checklist — paste into your trading log

Six checkboxes that catch common execution mistakes (wrong IV, illiquid option,
no GTC profit-take, etc).

### 3. The SKIP table — what you're passing on

One-line per ticker that didn't make the cut, with reason. Skim to confirm the
rejections make sense.

---

## Common workflows

### Daily morning scan

```
node scripts/wheel_batch.js \
  --tickers scans/wheel_universe.csv \
  --account 25000 \
  --out scans/$(date +%F)_wheel-batch.md
```

Run this with your morning coffee. Read the ENTER blocks. Pick 1–3 trades.

### Different expiry preference

```
node scripts/wheel_batch.js --tickers scans/wheel_universe.csv --dte 45
```

Default is 37 days. Common alternatives:
- `--dte 21` = three-week options (faster theta, more frequent management)
- `--dte 45` = monthly cycle (less time decay, smaller premium per day)

### Use the option chain's IV instead of realized

If you've looked at the actual option chain and the ATM IV is, say, 32%:

```
node scripts/wheel_batch.js --tickers MSFT --iv 0.32
```

The BS theoretical credit will then match what you'd actually receive much more
closely.

### Position sizing for a smaller account

```
node scripts/wheel_batch.js --tickers ... --account 10000 --max-pos 0.25
```

This says "at most 25% of my $10K account per position." Default is 10%.

### High-precision Monte Carlo

```
node scripts/wheel_batch.js --tickers ... --paths 20000
```

Default is 5,000 paths. Slower but tighter POP/p_assign estimates. Useful for
final verification on a candidate you're seriously considering.

### One-off check on a specific ticker not in your CSV

```
node scripts/wheel_batch.js --tickers PLTR --account 25000
```

---

## How to actually place the trade

The report gives you everything. Workflow:

1. Pick an ENTER ticker from the top of the report.
2. Open the ticker's option chain in your broker (ThinkorSwim, IBKR, etc).
3. Find the expiry **closest to the script's DTE** (e.g. 37 days = third Friday
   of next month most likely).
4. Look at the put strike from the report.
5. Confirm the actual bid/ask spread on that option is reasonable (the
   checklist says < 5% of mid; > 10% means skip).
6. Confirm open interest > 1000, daily volume > 100. Illiquid = bad fills.
7. Confirm the broker's delta is within ±5pp of the script's `Δ (BS)`. Big
   mismatch = IV skew is meaningful; consider re-running with `--iv`.
8. Place a **limit order at the midpoint**. Don't cross the spread.
9. If not filled in 5 minutes, walk the price by $0.05 closer to the bid.
10. Once filled, set a **GTC closing order at 50% of max profit** (the report
    tells you the exact dollar amount).
11. Log the trade in whatever journal you use (CSV, spreadsheet, broker notes).

---

## Troubleshooting

### "Yahoo HTTP 404" or "no chart data"

The ticker doesn't exist in Yahoo's database. Common reasons:
- Typo (e.g. `BRK.B` should be `BRK-B`)
- Delisted
- Foreign exchange (try a different suffix)

### "only N bars, need 100+"

Ticker is too new or has incomplete history. Common with recent IPOs. Skip it.

### A ticker shows `EV/trade: -$XYZ` even though it's an ENTER

The verdict is based on the three-layer composite (technical + Markov +
behavioral). The EV is based on the actual options math at the recommended
strike. **They can disagree.** When they do, **trust EV.** A negative-EV trade
is one you shouldn't take even if the technicals look good — the strike-level
risk is just too high relative to the premium.

Workaround: re-run with a deeper OTM strike to lower assignment risk:

```
node scripts/wheel_batch.js --tickers <ticker> --strike-otm 0.10
```

### "Position size: 0 contracts"

Your `--account × --max-pos` cap can't cover one contract of cash-secured
margin (which is `strike × 100`). Three options:

1. **Increase the per-position cap:** `--max-pos 0.25` (25%)
2. **Use a smaller-priced underlying:** scan a different ticker list
3. **Use margin instead of cash-secured:** the script doesn't model margin —
   your broker's reg-T or PMR margin will be lower, so adjust manually

### Stale data — Yahoo is hours behind

Yahoo's free endpoint can lag by 15+ minutes during the trading day. For
morning scans (pre-market or after close), this doesn't matter. For
intraday scans, prefer a live data source.

---

## When NOT to use this

- **Earnings within DTE** — the script doesn't know about earnings. A wheel
  trade through earnings is a different risk profile. Check the calendar
  manually before placing.
- **Binary events** — biotech FDA dates, M&A votes, etc. The GBM model assumes
  smooth diffusion; binary jumps break that.
- **Low-priced or illiquid stocks** — strike rounding to $1 doesn't make sense
  for a $4 stock. The script will run but the output is noisy.
- **As a "set and forget"** — every recommended trade needs human review of
  the actual option chain, IV environment, and macro context.

---

## Where things live

| Path | Purpose |
|---|---|
| `scripts/wheel_batch.js` | The scanner (this is what you run) |
| `docs/REFERENCE.md` | Technical reference (every flag, every formula) |
| `docs/GUIDE.md` | This file |
| `scans/wheel_universe.csv` | Your default ticker list — edit this |
| `scans/YYYY-MM-DD_wheel-batch.md` | Output reports (one per scan, optional) |
| `pine/WheelTriple.pine` | On-chart Pine indicator (same math, visual version) |
