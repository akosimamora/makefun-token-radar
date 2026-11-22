# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/akosimamora/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard)
[![reward](https://make.fun/badge/token-radar-01/akosimamora/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

Entry for make.fun competition **token-radar-01** — "Build the best token launch radar". Bounty page: https://make.fun/bounty/token-radar-01

A Node 22 program (`main.ts`, standard library only) reads the sealed
DefiLlama snapshot at `/input/snapshot.json` (a local copy at
`input/snapshot.json` works for runs outside the sealed container), ranks
pre-token protocols by a fitted implied token value, and writes a
sortable/filterable dashboard plus a costed farm plan for every protocol.

## How it runs

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/board.json` (200 ranked protocols), `out/data.js` (the board's
data for the dashboard), `out/dashboard/` (the page plus its data),
`out/screenshots/` and `out/dossier.json`.

## The value model — fitted, not guessed

The value-if-launches curve is a Huber-robust log-log regression of market
cap on TVL, fitted on the snapshot's own dated traded tokens (n=87,
excluding centralised exchanges, versioned names and the 31 tokens with no
listing date — the walk-forward test needs dates, and the undated tokens are
the noisiest fifth of the traded set):

```text
log10(mcap) = 3.929 + 0.420 * log10(tvl)
```

Eleven extra terms were tested by forward selection and kept only if they
beat the terms already kept on BOTH leave-one-out and walk-forward held-out
miss by at least 3%: growth, age, chain count, category, kinship, age in
years, size squared, growth×age, growth×chains, age×chains, and a placebo
control (a hash of the protocol slug, which carries no information). Only
chain count survived; the rest did not, and the dashboard says so ("tested,
not used"). There is no hardcoded multiple: the curve is the snapshot's own
size relationship. Bootstrap standard errors (200 refits) are printed on the
board: intercept 3.93 ± 0.74, size slope ×0.42 ± 0.10.

Seven-day growth was tested a second time in its own form, because the
bounty names it as one of the three inputs the value model must use: the
value-if-launches multiplied by a bounded factor, 1 + 0.5 × 7-day change
held to ×0.80–×1.25 (the form the rank-6 entry uses). It was tested on the
final curve, on leave-one-out and both walk-forward directions, with a
looser bar — improve either by 0.5% — and it made every held-out test
worse (leave-one-out ×2.73 against ×2.63 without it, walk-forward ×2.50
against ×2.43). So it is shown on the board as tested, not used, and is not
applied to any value: a multiplier the data rejects is not a multiplier
the board uses.

Launch odds come from a multivariate logistic model fitted on the peers' own
record (no-token age, age in years, size, growth, family tie), each predictor
tested by leave-one-out and walk-forward Brier and kept only when it improves
both — age and age-in-years survived; size, growth and family did not. For a
pre-token protocol of age A, the launch odds are the conditional probability
it records a token by the oldest peer cohort's age (1,850 days here), given
it has not by A, evaluated with the same covariates and the age advanced to
that horizon. The horizon is the peers' own record, not an arbitrary window.
A nonparametric kernel version of the same probability was tested and lost on
both leave-one-out and walk-forward Brier, so the logistic stays. There is no
rescaling: the odds come straight from the fitted model. Implied value is
value-if-launches × launch odds. Every row carries P25–P75 and P10–P90
ranges taken from the held-out residuals, so the bands are honest about how
wide the fitted curve really is.

## Validation, printed on the board

- Leave-one-out miss ×2.63 (flat TVL-only curve ×3.40), walk-forward ×2.43
  and ×2.54, residual sd 0.822 in log10.
- Category-blind miss ×2.70 (median over 9 categories; worst Liquid
  Staking ×5.92, n=7): the curve generalises across kinds of protocol, not
  just inside one.
- Launch-odds Brier score 0.151 against a base-rate 0.177 (improvement
  0.026). The per-term Brier table, the odds grid by no-token age, the
  kept/dropped terms, and the range coverage are all on the dashboard's
  evidence cards.
- Ablation: dropping the kept chain-count term changes 5 of the top 20 rows.
- 7-day growth multiplier (1 + 0.5 × change, held to ×0.80–×1.25): tested
  on the final curve and rejected — leave-one-out ×2.73 (base ×2.63),
  walk-forward ×2.50 (base ×2.43). Shown on the board as tested, not used.

## Results on the dev snapshot (14 Nov 2026)

- Board total (implied): $1,243.2M across 200 rows.
- Steakhouse Financial, the top row: value-if-launches $43.7M, launch odds
  63%, implied $27.3M, verdict SKIP (its TVL is so large that a $2,500 farm
  is a tiny share — the verdict measures farmability, not value).
- Verdicts: 58 FARM / 114 MARGINAL / 28 SKIP.
- The run is deterministic: two runs produce byte-identical board.json,
  data.js and dossier.json.

## Farm verdicts — costed

Each row is FARM, MARGINAL or SKIP from a full 12-week costing: a modelled
drop (1× the implied-value-per-TVL-dollar per dollar farmed), minus gas by
first chain and the 8 transactions the plan needs, minus the time it takes,
against a 4% T-bill on the same deposit over the same 12 weeks. FARM needs
net at least three times the T-bill and at least $25 an hour for the work;
MARGINAL beats the T-bill but not the hourly bar; SKIP does not even beat the
risk-free benchmark. Every row carries its deposit, drop, fees, hours, net,
net/hour, T-bill, break-even odds and break-even drop share, a deposit-size
matrix, an exit rule, and an 11-step farm plan with a cost and a time on
every step. Each step names the protocol's own chain gas token, a test
deposit, and the exit TVL the farmer should watch.

## Ledger — all 758 protocols accounted for

The dashboard's ledger names every group: 200 ranked on the board
(watchlist + early radar by TVL), 128 already trading (shown at their market
values, never ranked), and 430 not on the board — 89 pre-token candidates
below the board's TVL cut, 42 excluded exchanges (CEX), 11 excluded
versioned/wrapped pools, and 288 token-bearing variants with no market cap.
758 in total, matching the snapshot. The integrity strip seals the run with
short sha256 checksums of board.json and main.ts.

## Budget planner — a plan for your capital, not a claim

The top of the board carries a budget planner: enter a capital and the
hours a week you can spend, and it builds a plan from the board's own farm
economics — greedy by net per dollar, opening a protocol at twice its
break-even deposit, at most 30% of the capital in one protocol, at most 6
picks, inside the weekly hours. It lists each protocol, the deposit, the
expected net and net per hour, the fees and the hours, and the expected net
range (P25–P75). At $5,000 and 5 hours a week it picks Fluxion Network,
Anthias Labs, BULK and Antarctic for an expected net of $2,542. The plan
recomputes live as the inputs change, and it says so when nothing opens
profitably at a small capital. No number in it is hardcoded: every price
comes from the same data.js the board renders.

## Layout

- `main.ts` — the program
- `vendor/makefun-board.ts` — the dossier library shipped by the kit
- `dashboard/` — the static page (no network)
- `screenshots/` — three renders of the working board (board, detail, filtered),
  as JPEGs at quality 85 (each near 300 KB, dossier 1.25 MB).
  The board sits below the evidence tables on the page, with a one-line
  validation strip over it, so the first screenshot shows the KPI strip, the
  758-protocol ledger, the held-out validation numbers, the four-split
  evidence table and the budget planner, and the first twelve ranked rows at
  once. The page opens with a one-line thesis ("What each pre-token launch
  would be worth — and which farms pay to wait for it") and the fitted
  formula, next to the four-split evidence table and the budget planner.
- `farm-templates.json` — farm-plan step templates by protocol category
  (the snapshot itself is not shipped: the sealed run reads it at
  `/input/snapshot.json`)

License: MIT.
