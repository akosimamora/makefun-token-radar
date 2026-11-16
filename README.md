# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/akosimamora/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard)
[![reward](https://make.fun/badge/token-radar-01/akosimamora/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

Entry for make.fun competition **token-radar-01** — "Build the best token launch radar". Bounty page: https://make.fun/bounty/token-radar-01

A Node 22 program (`main.ts`, standard library only) reads the sealed
DefiLlama snapshot at `/input/snapshot.json` (a local copy at
`input/snapshot.json` works for runs outside the sealed container), ranks
pre-token protocols by an implied token value, and writes a sortable/filterable
dashboard plus a farm plan for every protocol.

## How it runs

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/board.json` (195 ranked protocols), `out/dashboard/` (the page
plus its data), `out/screenshots/` and `out/dossier.json`.

## The value model

```
implied value = TVL x 0.30 x growth x age x chains x plausibility
```

- **growth** = 1 + clamped 7-day TVL change (0.50–2.00)
- **age** = 0.80 + 0.10 per year tracked tokenless, capped 1.20
- **chains** = 1.00–1.10 by chain count
- **plausibility** = 1.00 for genuine pre-token protocols

Centralised exchanges, bridges, liquid staking/restaking products, wrapped or
staked products, versioned names and tokens that already trade are excluded
from the ranking. The gate requires every watchlist slug on the board, so the
two watchlist members whose tokens already trade (USDD, bittensor-dtao) appear
last with nominal values and an honest note instead of a farm plan.

## Layout

- `main.ts` — the program
- `vendor/makefun-board.ts` — the dossier library shipped by the kit
- `dashboard/` — the static page (no network)
- `screenshots/` — three renders of the dashboard
- `farm-templates.json` — farm-plan step templates by protocol category
  (the snapshot itself is not shipped: the sealed run reads it at
  `/input/snapshot.json`)

License: MIT.
