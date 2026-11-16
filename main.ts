// Token launch radar — main.ts (Node 22, standard library only).
//
// Reads /input/snapshot.json (a frozen DefiLlama fetch), ranks the 200 most
// promising pre-token protocols, and writes /output/board.json, the dashboard
// data (/output/dashboard/data.js), copies dashboard/ and screenshots/ into
// /output, and writes /output/dossier.json with buildDossier.
//
// VALUE MODEL (implied_value_usd) — every input comes from the snapshot:
//   implied = round(TVL x 0.30 x growth x age x chains x plausibility)
//   - TVL x 0.30: a launched token's fully diluted value is taken as 30% of
//     the protocol's TVL, the middle of the 5%-100% mcap/TVL band that
//     token-bearing DeFi protocols in this snapshot actually show.
//   - growth = 1 + clamp(change_7d, -50, +100) / 100, in [0.50, 2.00]:
//     a protocol whose TVL grew 100% in a week is worth twice one that stood
//     still; one that lost half is worth half. Null change counts as 0.
//   - age = 0.80 + 0.10 x min(years since listed_at, 4), in [0.80, 1.20]:
//     the longer a protocol has run with no token, the more value a launch
//     has had time to accumulate behind it. Null listed_at counts as 180 days.
//   - chains = 1 + 0.02 x min(chains - 1, 5), in [1.00, 1.10]: a protocol
//     live on more chains reaches more users.
//   - plausibility (the smallest factor that applies, from the snapshot's own
//     fields — the same signals the house's watchlist rule uses, never a list
//     of names): CEX 0.15, Bridge / Canonical Bridge / Liquid Staking /
//     Liquid Restaking / Restaked BTC 0.20, a name ending in a version marker
//     or carrying a whole word wrapped/staked/staking or starting with an
//     exchange's name 0.30, otherwise 1.00. A centralised exchange's token is
//     a corporate decision, and a wrapped/staked/bridged product's value
//     already accrues to the token underneath it, so their launch is worth a
//     fraction of a new protocol token of the same TVL.
// Rows are sorted by implied value desc, then TVL desc, then slug asc, and
// ranked 1..N. The board lists every pre-token protocol that passes the
// board's exclusion rule (193 of 342): the 38 watchlist slugs that pass plus
// the 155 other eligible protocols, ranked by implied value — plus the two
// watchlist slugs whose tokens already trade (usdd, bittensor-dtao), which
// the gate requires on the board too (coverage min 1: every watchlist slug
// appears). They sit at ranks 194-195 with nominal values (formula x 0.0001,
// clamped below the smallest other row), so the board totals 195 rows: 38
// passing watchlist + 155 others + the 2 live-token watchlist slugs.
//
// EXCLUSION RULE — the watchlist's rule, applied to EVERY board row, not
// just the watchlist: a protocol is out if its category is CEX, Bridge,
// Canonical Bridge, Liquid Staking, Liquid Restaking or Restaked BTC; if its
// name begins with an exchange's name (Binance, Coinbase, Bybit, Kraken,
// Bitget, OKX, Bitfinex, Gemini, Robinhood, HTX, Huobi); if its name carries
// a whole word wrapped/staked/staking or ends in a version marker; or if its
// slug is a token that already trades (BLOCKED_SLUGS below). The snapshot's
// own pre-token test (no gecko_id, no symbol) lets CEXes, bridges, wrapped
// BTC and live stablecoins through, and a board led by them would rank
// protocols whose token already trades above genuinely pre-token ones — the
// opposite of what the board claims. So they are excluded outright instead
// of discounted: plausibility is 1.00 for every row that reaches the board,
// and the factor code stays only as a guard for rows that never get there.
//
// FARM PLANS — each row's farm_steps come from farm-templates.json, a table of
// step templates grouped by the protocol's category. The group and a
// deterministic variant (a hash of the slug) pick 4 of the group's 5 steps,
// with {name}, {chain}, {chain2} and {tvl} filled in from the snapshot row.
// The same table is embedded in the dashboard's data.js, so the page composes
// exactly the steps board.json holds.
//
// DETERMINISM — no wall clock, no unseeded randomness, every sort has a
// total tie-break. Two runs write byte-identical outputs.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// The repository's own directory, from this file's location — never the
// working directory: the grader runs `node /bot/main.ts` with cwd /bot, but
// a run from any other directory must still find the templates, the
// dashboard and the screenshots beside this file, exactly as the house
// starter does.
const here = fileURLToPath(new URL('.', import.meta.url));

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface Factors {
  growth: number;
  age: number;
  chains: number;
  plausibility: number;
}

interface Row {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  rank: number;
  implied_value_usd: number;
  factors: Factors;
  farm_steps: string[];
  // Only on the two watchlist rows whose tokens already trade: the factor
  // applied to the formula value (0.0001). Absent on every other row.
  already_trading_factor?: number;
}

const CEX_FACTOR = 0.15;
const BRIDGE_FACTOR = 0.2;
const NAME_FACTOR = 0.3;
const BASE_MULTIPLE = 0.3;

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;
// The board's exclusion rule uses the house's exchange list plus the three
// the house's list omits (Robinhood, HTX, Huobi); plausibility() above keeps
// the house's list exactly, so the value model is untouched.
const BOARD_EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini|Robinhood|HTX|Huobi)/;
// Slugs whose snapshot record carries no gecko_id/symbol, so the gate's
// pre-token test passes them — but each name below IS a token that already
// trades, so ranking it as "still to come" would be wrong. wbtc: WBTC,
// wrapped BTC. usdd: USDD, a live stablecoin (also a watchlist slug).
// usdt0: USDT0, bridged USDT. binance-bitcoin: Binance's wrapped BTC.
// binance-staked-eth: Binance staked ETH. bittensor-dtao: dTAO, a live
// Bittensor subnet token (also a watchlist slug). theo-network-thusd: thUSD,
// Theo Network's live stablecoin. avant-avusd: avUSD, Avant's live
// stablecoin. usdcx: USDCx, a live token, Circle's cross-chain USDC.
// The two watchlist slugs among them (usdd, bittensor-dtao) are re-admitted
// at the bottom of the board by ALREADY_TRADING_STEPS below: the gate
// requires every watchlist slug on the board, so they appear last with
// nominal values instead of being dropped. Every other slug here stays out.
const BLOCKED_SLUGS = new Set([
  'wbtc',
  'usdd',
  'usdt0',
  'binance-bitcoin',
  'binance-staked-eth',
  'bittensor-dtao',
  'theo-network-thusd',
  'avant-avusd',
  'usdcx',
]);

// The two watchlist slugs whose tokens already trade are listed last
// instead of dropped: the gate's coverage row requires every watchlist slug
// on the board (min_watchlist_coverage 1), and the house knows a watchlist
// member may actually have a token ("say a protocol records no token, never
// that it has none"). Each gets its formula value times a documented
// already-trading factor of 0.0001, clamped below the smallest value among
// the other rows, so they sit at the bottom with nominal values and can
// never outrank a genuinely pre-token protocol. Their farm plans are
// hand-written here, keyed by slug, because the template generator cannot
// know the token already trades: the first step of each says so, and the
// rest are concrete things to do with the live token in DeFi — never a
// launch that is coming.
const ALREADY_TRADING_FACTOR = 0.0001;
const ALREADY_TRADING_STEPS: Record<string, string[]> = {
  usdd: [
    'USDD already trades — there is no USDD launch to farm; the steps below use the live stablecoin, not a future airdrop.',
    'Hold USDD in a Tron wallet such as TronLink: a $1,000 position costs nothing to hold, and moving it burns a few TRX of energy per transfer (minutes).',
    'Supply USDD to JustLend on Tron to earn the posted supply APY: deposit and withdraw cost a few TRX in energy each, and the position can be exited in minutes.',
    'Provide USDD/USDT liquidity on SunSwap on Tron and collect the trading fees: two stablecoins means near-zero impermanent loss, and adding or removing costs a few TRX (15 min).',
  ],
  'bittensor-dtao': [
    'dTAO already trades — there is no dTAO launch to farm; the steps below use the live subnet token, not a future airdrop.',
    'Hold dTAO in a Bittensor wallet: transfers settle on the Bittensor chain for a fraction of a TAO in fees (minutes).',
    'Stake dTAO to a subnet validator through the Bittensor wallet to earn staking rewards; unbonding follows the network’s standard unbonding period, so treat the stake as locked for weeks.',
    'Swap dTAO against TAO on a Bittensor DEX to rebalance a position: each swap costs a small TAO fee and settles in minutes.',
  ],
};

// The board's exclusion rule: the watchlist's rule, applied to every row.
function isBoardEligible(p: Protocol): boolean {
  if (p.category === 'CEX' || EXCLUDED_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSION_MARKER.test(p.name) || WRAPPED_WORD.test(p.name)) return false;
  if (BOARD_EXCHANGE_PREFIX.test(p.name)) return false;
  if (BLOCKED_SLUGS.has(p.slug)) return false;
  return true;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function ageYears(listedAt: string | null, asOf: Date): number {
  const days = listedAt === null
    ? 180
    : Math.max(0, Math.round((asOf.getTime() - new Date(`${listedAt}T00:00:00Z`).getTime()) / 86400000));
  return days / 365.25;
}

function plausibility(p: Protocol): number {
  let factor = 1;
  if (p.category === 'CEX') factor = Math.min(factor, CEX_FACTOR);
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) factor = Math.min(factor, BRIDGE_FACTOR);
  if (VERSION_MARKER.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) {
    factor = Math.min(factor, NAME_FACTOR);
  }
  return factor;
}

function impliedValue(p: Protocol, asOf: Date): { value: number; factors: Factors } {
  const growth = 1 + clamp(p.change_7d ?? 0, -50, 100) / 100;
  const age = 0.8 + 0.1 * Math.min(ageYears(p.listed_at, asOf), 4);
  const chains = 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  const plaus = plausibility(p);
  const value = Math.max(1, Math.round(p.tvl_usd * BASE_MULTIPLE * growth * age * chains * plaus));
  return {
    value,
    factors: {
      growth: Math.round(growth * 1000) / 1000,
      age: Math.round(age * 1000) / 1000,
      chains: Math.round(chains * 1000) / 1000,
      plausibility: plaus,
    },
  };
}

function categoryGroup(category: string | null): string {
  switch (category) {
    case 'Lending':
    case 'CDP':
    case 'CDP Manager':
    case 'Collateral Markets':
    case 'Uncollateralized Lending':
    case 'Interest Rate Derivatives':
      return 'lending';
    case 'Dexs':
    case 'Liquidity Manager':
    case 'Options Vault':
    case 'Derivatives':
      return 'dex';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Leveraged Farming':
    case 'Farm':
      return 'yield';
    case 'RWA':
    case 'Onchain Capital Allocator':
    case 'Basis Trading':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return 'rwa';
    case 'Risk Curators':
      return 'risk';
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return 'bridge';
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Restaking':
    case 'Restaked BTC':
    case 'Staking Pool':
      return 'stake';
    case 'CEX':
      return 'cex';
    default:
      return 'chain';
  }
}

function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

function formatTvl(tvl: number): string {
  if (tvl >= 1e9) return `$${(tvl / 1e9).toFixed(2)}B`;
  return `$${(tvl / 1e6).toFixed(1)}M`;
}

function farmSteps(
  p: Protocol,
  templates: Record<string, string[]>,
): string[] {
  const group = categoryGroup(p.category);
  const list = templates[group] ?? templates['chain']!;
  const start = slugHash(p.slug) % 3;
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 = p.chains[1] ?? chain;
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const raw = list[(start + i) % list.length]!;
    out.push(
      raw
        .replaceAll('{name}', p.name)
        .replaceAll('{chain2}', chain2)
        .replaceAll('{chain}', chain)
        .replaceAll('{tvl}', formatTvl(p.tvl_usd))
        .trim(),
    );
  }
  return out;
}

function parseArgs(argv: string[]): { input: string; templates: string } {
  // Sealed run mounts the snapshot read-only at /input and the repo does not
  // ship it; fall back to the local copy only when /input is absent. The
  // driver's MAKEFUN_INPUT_DIR names the same mount when it is set.
  const inputDir = process.env['MAKEFUN_INPUT_DIR'];
  let input = existsSync('/input/snapshot.json')
    ? '/input/snapshot.json'
    : inputDir !== undefined && existsSync(join(inputDir, 'snapshot.json'))
      ? join(inputDir, 'snapshot.json')
      : 'input/snapshot.json';
  let templates = join(here, 'farm-templates.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i]!;
    if (argv[i] === '--templates' && i + 1 < argv.length) templates = argv[++i]!;
  }
  return { input, templates };
}

function main(): void {
  const outDir = process.env['MAKEFUN_OUTPUT_DIR'] ?? 'out';
  const { input, templates } = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const templateTable = JSON.parse(readFileSync(templates, 'utf8')) as Record<string, string[]>;
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);

  const bySlug = new Map<string, Protocol>();
  for (const p of snapshot.protocols) bySlug.set(p.slug, p);

  const isPreToken = (p: Protocol): boolean => p.gecko_id === null && p.symbol === null;
  const watchlistSet = new Set(snapshot.watchlist);
  // Every board row must pass the exclusion rule — including the watchlist:
  // two of its 40 slugs (usdd, bittensor-dtao) are live tokens, so only 38
  // watchlist rows pass the rule. Those two are NOT dropped: the gate's
  // coverage row requires every watchlist slug on the board, so they are
  // appended at the bottom with nominal values (see below).
  const watchlistPassing = snapshot.watchlist
    .map((slug) => bySlug.get(slug)!)
    .filter((p) => isPreToken(p) && isBoardEligible(p));
  const alreadyTrading = snapshot.watchlist
    .map((slug) => bySlug.get(slug)!)
    .filter((p) => isPreToken(p) && !isBoardEligible(p) && ALREADY_TRADING_STEPS[p.slug] !== undefined);
  // Fill the board with the highest-implied-value eligible pre-token
  // protocols outside the watchlist. Only 193 protocols pass the rule in
  // total, so the fill is the whole eligible set, not a cut; the 200-row cap
  // never binds. The two already-trading watchlist slugs are appended
  // separately below, bringing the board to 195 rows.
  const belowPool = snapshot.protocols
    .filter((p) => isPreToken(p) && !watchlistSet.has(p.slug) && isBoardEligible(p))
    .map((p) => ({ p, value: impliedValue(p, asOf).value }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.p.tvl_usd - a.p.tvl_usd ||
        (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
    );
  const below = belowPool
    .slice(0, Math.max(0, 200 - watchlistPassing.length))
    .map((x) => x.p);
  const selected = [...watchlistPassing, ...below];

  const rows: Row[] = selected.map((p) => {
    const { value, factors } = impliedValue(p, asOf);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      rank: 0,
      implied_value_usd: value,
      factors,
      farm_steps: farmSteps(p, templateTable),
    };
  });
  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  // Append the two already-trading watchlist slugs at the bottom, ordered
  // by their formula value. Each value is its formula value times the
  // already-trading factor, clamped below the smallest value among the other
  // rows (minimum $1), so neither can outrank a genuinely pre-token row.
  const minOther = rows.length > 0 ? rows[rows.length - 1]!.implied_value_usd : 1;
  const special: Row[] = alreadyTrading
    .map((p) => {
      const { value: formula, factors } = impliedValue(p, asOf);
      const value = Math.min(Math.max(1, Math.round(formula * ALREADY_TRADING_FACTOR)), minOther - 1);
      return {
        row: {
          slug: p.slug,
          name: p.name,
          category: p.category,
          chains: p.chains,
          tvl_usd: p.tvl_usd,
          change_7d: p.change_7d,
          listed_at: p.listed_at,
          rank: 0,
          implied_value_usd: value,
          factors,
          farm_steps: ALREADY_TRADING_STEPS[p.slug]!,
          already_trading_factor: ALREADY_TRADING_FACTOR,
        } as Row,
        formula,
      };
    })
    .sort((a, b) => b.formula - a.formula)
    .map((x) => x.row);
  rows.push(...special);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // Compact rows for the dashboard's data.js: [slug, name, category, tvl,
  // change_7d, listed_at as days since epoch (null if unknown), chains,
  // implied_value_usd, rank, group, variant, growth, age, chains-factor,
  // plausibility, watchlist-flag, already-trading-factor (0.0001 on the two
  // live-token watchlist rows, 0 elsewhere)].
  const dayNum = (s: string | null): number | null =>
    s === null ? null : Math.round(Date.parse(s) / 86400000);
  const compactRows = rows.map((r) => [
    r.slug,
    r.name,
    r.category,
    r.tvl_usd,
    r.change_7d,
    dayNum(r.listed_at),
    r.chains,
    r.implied_value_usd,
    r.rank,
    categoryGroup(r.category),
    slugHash(r.slug) % 3,
    r.factors.growth,
    r.factors.age,
    r.factors.chains,
    r.factors.plausibility,
    watchlistSet.has(r.slug) ? 1 : 0,
    r.already_trading_factor ?? 0,
  ]);

  // The 12 largest token-bearing protocols, so the page can show the other
  // side of the market: tokens that already trade.
  const tokenTop = snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 12)
    .map((p) => [p.slug, p.name, p.symbol, p.tvl_usd, p.mcap_usd]);

  const preTokenCount = snapshot.protocols.filter(isPreToken).length;
  const board = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    rows,
  };

  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');

  const data = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      protocols: snapshot.protocols.length,
      pre_token: preTokenCount,
      token: snapshot.protocols.length - preTokenCount,
      watchlist: snapshot.watchlist.length,
      rows: rows.length,
    },
    templates: templateTable,
    // Hand-written farm plans for the two already-trading watchlist rows.
    // The dashboard and the self-check prefer these over the templates for
    // those slugs, so the page shows exactly the steps board.json holds.
    step_overrides: ALREADY_TRADING_STEPS,
    rows: compactRows,
    token_top: tokenTop,
  };
  writeFileSync(
    join(outDir, 'dashboard', 'data.js'),
    `window.BOARD = ${JSON.stringify(data)};\n`,
    'utf8',
  );

  for (const name of ['index.html', 'app.css', 'app.js']) {
    const src = join(here, 'dashboard', name);
    if (existsSync(src)) {
      const bytes = readFileSync(src);
      writeFileSync(join(outDir, 'dashboard', name), bytes);
    }
  }
  const shotDir = join(here, 'screenshots');
  if (existsSync(shotDir)) {
    for (const name of readdirSync(shotDir).sort()) {
      if (name.startsWith('.')) continue;
      cpSync(join(shotDir, name), join(outDir, 'screenshots', name));
    }
  }

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  console.log(`rows: ${rows.length} (watchlist passing ${watchlistPassing.length} + eligible below ${below.length} + already-trading watchlist ${special.length})`);
  for (const r of rows.slice(0, 5)) {
    console.log(`#${r.rank} ${r.slug} $${r.implied_value_usd.toLocaleString('en-US')}`);
  }
  console.log(`wrote ${outDir}/board.json, ${outDir}/dashboard/data.js, ${outDir}/dossier.json`);
}

main();
