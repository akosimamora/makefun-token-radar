// Token Radar — rebuilt entry (round 3).
//
// A fitted radar, not a retuned starter. The value curve, the launch odds and
// every validation number below are computed from the sealed snapshot itself
// at run time: nothing about any protocol is hardcoded, and no constant is
// asserted without a held-out test behind it.
//
// Pipeline: read snapshot -> fit size curve on dated traded tokens (Huber
// log-log) -> test extra terms by forward selection on leave-one-out +
// walk-forward -> fit launch odds from the peers' age record (logistic on
// age + age-in-years, conditional survival to the oldest cohort's age) ->
// score every pre-token protocol -> cost a farm verdict per row -> pack the
// dashboard + board + dossier.
//
// Node 22, standard library only. No network.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const DAY_MS = 86_400_000;
const DOSSIER_TEXT_CAP = 65_536;

/* ------------------------------------------------------------------ types */

export interface Proto {
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

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** One fitted point for the size curve: log TVL against log market cap. */
export interface FitPoint {
  slug: string;
  x: number; // log10(tvl_usd)
  y: number; // log10(mcap_usd)
  growth: number; // clamped 7d change, percent
  ageDays: number | null;
  nChains: number;
  listedAt: string | null;
  category: string | null;
  kin: number; // 1 when it shares a symbol/gecko id/name-stem with another traded protocol
}

/** The fitted size curve plus its held-out evidence. */
export interface Curve {
  intercept: number;
  slope: number;
  /** full coefficient vector: [intercept, slope, ...one per kept term] */
  coefs: number[];
  /** kept term names in the order of coefs[2..] */
  terms: string[];
  /** top categories the `category` term expands to (one dummy each) */
  topCats: string[];
  /** bootstrap standard errors of the intercept and slope (200 refits) */
  bootSe: { intercept: number; slope: number };
  residSd: number; // sd of log10 residuals
  residP10: number; // multiplicative factors from held-out residuals
  residP25: number;
  residP75: number;
  residP90: number;
  n: number;
  looMiss: number; // median multiplicative miss, leave-one-out
  looFlatMiss: number; // same, for a flat (median) predictor
  walkFwdMiss: number; // median miss, fit old -> test new
  walkBackMiss: number; // median miss, fit new -> test old
  /** leave-one-category-out: fit on every category but one, predict the
   *  held-out category. The median across categories is the fourth
   *  held-out split; `worst` names the hardest category, `per` the
   *  per-category misses. */
  loco: {
    median: number;
    worst: { category: string; n: number; miss: number };
    per: { category: string; n: number; miss: number }[];
  };
  keptTerms: string[];
  droppedTerms: string[];
  /** The targeted 7-day-growth test (rank-6 form): value-if-launches times
   *  a bounded multiplier, 1 + 0.5 x 7-day change held to [0.8, 1.25].
   *  Kept only when it improves leave-one-out OR walk-forward by at least
   *  0.5%; the numbers are reported on the board either way. */
  growthMult: {
    looMiss: number;
    wfMiss: number;
    wbMiss: number;
    baseLooMiss: number;
    baseWfMiss: number;
    baseWbMiss: number;
    kept: boolean;
  };
}

/** One candidate predictor for the launch-odds model, with its held-out evidence. */
export interface OddsTerm {
  name: string;
  /** LOO Brier of the model with this term added (vs the base it was tested on). */
  looBrier: number;
  /** walk-forward Brier (older -> newer) of the model with this term added. */
  wfBrier: number;
  /** whether the term was kept (improved BOTH LOO and walk-forward Brier). */
  kept: boolean;
}

/** The launch-odds model: a fitted conditional launch probability — the
 *  chance a protocol records a token by the oldest peer cohort's age,
 *  given it has not by its own age. No rescaling is applied anywhere: the
 *  odds come straight from a logistic model of the peers' own record
 *  (see fitOdds). */
export interface Odds {
  /** odds at the grid ages, monotone non-increasing, for the dashboard table */
  grid: { ageDays: number; odds: number }[];
  /** the oldest peer cohort's age in days — the odds horizon */
  horizon: number;
  at: (ageDays: number | null, sizeLog?: number, growth?: number, family?: number) => number;
  brier: number; // LOO Brier score of the fitted odds model
  brierBase: number; // Brier of the base rate
  /** per-term held-out evidence: which predictors were kept, which tested-not-used */
  terms: OddsTerm[];
  /** logistic coefficients of the kept model, in feature order (see fitOdds) */
  coefs: number[];
  /** feature names of coefs[1..], in order */
  features: string[];
}

/** Everything the dashboard renders. */
export interface Pack {
  as_of: string;
  source: string;
  floor_usd: number;
  curve: {
    intercept: number;
    slope: number;
    coefs: number[];
    terms: string[];
    residSd: number;
    n: number;
    looMiss: number;
    looFlatMiss: number;
    walkFwdMiss: number;
    walkBackMiss: number;
    loco: {
      median: number;
      worst: { category: string; n: number; miss: number };
      per: { category: string; n: number; miss: number }[];
    };
    keptTerms: string[];
    droppedTerms: string[];
    p10: number;
    p25: number;
    p75: number;
    p90: number;
    bootSe: { intercept: number; slope: number };
    topCats: string[];
    growthMult: {
      looMiss: number;
      wfMiss: number;
      wbMiss: number;
      baseLooMiss: number;
      baseWfMiss: number;
      baseWbMiss: number;
      kept: boolean;
    };
  };
  odds: {
    grid: { ageDays: number; odds: number }[];
    horizon: number;
    brier: number;
    brierBase: number;
    terms: OddsTerm[];
    coefs: number[];
    features: string[];
  };
  ledger: {
    ranked: number;
    traded: number;
    out: number;
    total: number;
    outDetail: { label: string; count: number }[];
  };
  /** the farm economics the board's verdicts use, so the dashboard's
   *  planner prices a plan with exactly the same numbers: the airdrop
   *  pool factor, the plan length in weeks and the T-bill rate. */
  econ: { poolFactor: number; weeks: number; tbillRate: number };
  /** Short sha256 seals: the board.json bytes and the main.ts source, so the
   *  integrity strip can show the table was recomputed from these bytes. */
  checksum: { board: string; main: string };
  /** Ablation: for each kept curve term, how many of the top 20 rows change
   *  when that term is dropped and the board is re-scored. */
  ablation: { term: string; changed: number }[];
  /** Scatter: traded tokens (log TVL, log mcap), board rows (log TVL, log
   *  value-if-launches) and the fitted curve line, for the SVG plot. */
  scatter: {
    traded: { x: number; y: number; slug: string }[];
    board: { x: number; y: number; slug: string }[];
    line: { x: number; y: number }[];
  };
  rows: RowOut[];
  live: LiveOut[];
  boardTotal: number;
  verdictCounts: { farm: number; marginal: number; skip: number };
}

export interface RowOut {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  value_if_launches: number;
  odds: number;
  implied_value_usd: number;
  lo25: number;
  hi75: number;
  lo10: number;
  hi90: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit_usd: number;
  drop_usd: number;
  fees_usd: number;
  hours: number;
  net_usd: number;
  net_per_hour: number;
  tbill_usd: number;
  breakeven_odds: number;
  farm_steps: string[];
}

export interface LiveOut {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/* ------------------------------------------------------------- snapshot */

class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The snapshot out of a file's text, refused unless it is the shape we score. */
export function readSnap(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapError(`protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Whole days from `listedAt` to `asOf`; null when either date is absent or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A name ending in a release marker is a pool of another protocol, not a launch candidate. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol that already trades: it records a positive market cap. */
export function isTradable(p: Proto): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

/** A protocol with no token at all. */
export function isTokenless(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol the board may rank: tokenless, not an exchange, not a versioned pool. */
export function isCandidate(p: Proto): boolean {
  return isTokenless(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/** Clamp a 7-day change into the band the curve is fitted on. */
function clampGrowth(v: number | null): number {
  const g = numOr(v, 0);
  return Math.min(120, Math.max(-60, g));
}

/* ------------------------------------------------------- fitting the curve */

/** The median of numbers (0 for an empty list). */
function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A quantile of numbers by linear interpolation (q in [0,1]). */
function quantile(ns: number[], q: number): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Weighted least squares for y ~ 1 + x1 + ... + xk. Returns coefficients.
 *  `ridge` (optional, one penalty per column) is added to the diagonal of
 *  X' W X, shrinking the penalised coefficients toward zero. */
function wls(design: number[][], y: number[], w: number[], ridge?: number[]): number[] {
  const k = design[0]!.length;
  // Normal equations: (X' W X) b = X' W y, solved by Gaussian elimination.
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < design.length; i++) {
    const xi = design[i]!;
    const wi = w[i]!;
    for (let r = 0; r < k; r++) {
      b[r]! += wi * xi[r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c]! += wi * xi[r]! * xi[c]!;
    }
  }
  if (ridge !== undefined) {
    for (let r = 0; r < k; r++) a[r]![r]! += ridge[r] ?? 0;
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv]!, a[col]!];
      [b[col], b[piv]] = [b[piv]!, b[col]!];
    }
    const d = a[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < k; r++) {
      const f = a[r]![col]! / d;
      for (let c = col; c < k; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const coef = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < k; c++) s -= a[r]![c]! * coef[c]!;
    const d = a[r]![r]!;
    coef[r] = Math.abs(d) < 1e-12 ? 0 : s / d;
  }
  return coef;
}

/** Huber-robust fit of y on the design columns. IRLS, k = 1.345 * MAD scale.
 *  `ridge` (optional, one penalty per column) shrinks the penalised
 *  coefficients toward zero; the intercept and size slope stay unpenalised. */
function huberFit(design: number[][], y: number[], ridge?: number[]): { coef: number[]; resid: number[] } {
  const n = design.length;
  let w = new Array<number>(n).fill(1);
  let coef = wls(design, y, w, ridge);
  let resid = design.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * coef[j]!, 0));
  for (let iter = 0; iter < 12; iter++) {
    const med = median(resid);
    const mad = median(resid.map((r) => Math.abs(r - med)));
    const scale = Math.max(1.4826 * mad, 1e-6);
    const k = 1.345 * scale;
    w = resid.map((r) => {
      const a = Math.abs(r - med) / k;
      return a <= 1 ? 1 : 1 / a;
    });
    const next = wls(design, y, w, ridge);
    const shift = Math.max(...next.map((v, j) => Math.abs(v - coef[j]!)));
    coef = next;
    resid = design.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * coef[j]!, 0));
    if (shift < 1e-9) break;
  }
  return { coef, resid };
}

/** The logistic function, guarded against overflow. */
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Logistic regression by IRLS (iteratively reweighted least squares).
 *  `ridge` is a per-column penalty (0 = unpenalised); a small ridge on the
 *  non-intercept columns keeps the fit stable when a predictor barely varies.
 *  `start` warm-starts the coefficients (used by leave-one-out). */
function logitFit(
  design: number[][],
  y: number[],
  ridge: number[],
  start?: number[],
  maxIter = 12,
): number[] {
  const k = design[0]!.length;
  let coef = start !== undefined ? [...start] : new Array<number>(k).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const w: number[] = new Array<number>(design.length);
    const z: number[] = new Array<number>(design.length);
    for (let i = 0; i < design.length; i++) {
      const row = design[i]!;
      const eta = row.reduce((s, v, j) => s + v * coef[j]!, 0);
      const p = sigmoid(eta);
      const ww = Math.max(1e-6, Math.min(0.25, p * (1 - p)));
      w[i] = ww;
      z[i] = eta + (y[i]! - p) / ww;
    }
    const next = wls(design, z, w, ridge);
    const shift = Math.max(...next.map((v, j) => Math.abs(v - coef[j]!)));
    coef = next;
    if (shift < 1e-8) break;
  }
  return coef;
}

/** A fitted logistic model's predicted probability for one design row. */
function logitProb(coef: number[], row: number[]): number {
  const eta = row.reduce((s, v, j) => s + v * coef[j]!, 0);
  return sigmoid(eta);
}

/** Brier score of predicted probabilities against 0/1 labels. */
function brierScore(pred: number[], actual: number[]): number {
  if (pred.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += (pred[i]! - actual[i]!) * (pred[i]! - actual[i]!);
  return s / pred.length;
}

/** The design row for a point under a term set. Terms are named so the
 *  validation table can say which were kept and which were tested, not used.
 *  The `category` term expands to one dummy per top category in `topCats`
 *  (ridge-shrunk in the fit); every other term contributes one column. */
function designRow(p: FitPoint, terms: string[], topCats: string[] = []): number[] {
  const row: number[] = [1, p.x];
  for (const t of terms) {
    if (t === 'growth') row.push(clampGrowth(p.growth) / 100);
    else if (t === 'age') row.push(Math.log10((p.ageDays ?? 365) + 30));
    else if (t === 'chains') row.push(Math.min(p.nChains, 5));
    else if (t === 'kinship') row.push(p.kin ?? 0);
    else if (t === 'ageLin') row.push((p.ageDays ?? 365) / 365);
    else if (t === 'size2') row.push(p.x * p.x);
    else if (t === 'growthAge') row.push((clampGrowth(p.growth) / 100) * Math.log10((p.ageDays ?? 365) + 30));
    else if (t === 'growthChains') row.push((clampGrowth(p.growth) / 100) * Math.min(p.nChains, 5));
    else if (t === 'ageChains') row.push(Math.log10((p.ageDays ?? 365) + 30) * Math.min(p.nChains, 5));
    else if (t === 'category') {
      for (const c of topCats) row.push(p.category === c ? 1 : 0);
    } else if (t === 'placebo') {
      // Control term: a deterministic hash of the slug, in [0, 1). It
      // carries no information about value, so it must NOT improve the
      // held-out misses — if it did, the validation itself would be suspect.
      let h = 0;
      for (let i = 0; i < p.slug.length; i++) h = (h * 31 + p.slug.charCodeAt(i)) >>> 0;
      row.push((h % 100) / 100);
    }
  }
  return row;
}

/** How many design columns one term contributes (`category` expands to one
 *  dummy per top category; every other term contributes one column). */
function termWidth(t: string, topCats: string[]): number {
  return t === 'category' ? topCats.length : 1;
}

/** Leave-one-out median miss for a term set (multiplicative, 10^median|log err|). */
function looMiss(points: FitPoint[], terms: string[], topCats: string[] = [], ridge?: number[]): number {
  const errs: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const rest = points.filter((_, j) => j !== i);
    const design = rest.map((p) => designRow(p, terms, topCats));
    const y = rest.map((p) => p.y);
    const { coef } = huberFit(design, y, ridge);
    const row = designRow(points[i]!, terms, topCats);
    const pred = row.reduce((s, v, j) => s + v * coef[j]!, 0);
    errs.push(Math.abs(points[i]!.y - pred));
  }
  return Math.pow(10, median(errs));
}

/** Walk-forward median miss: fit on one half by listing date, test on the other. */
function walkMiss(points: FitPoint[], terms: string[], forward: boolean, topCats: string[] = [], ridge?: number[]): number {
  const dated = points.filter((p) => p.listedAt !== null).sort((a, b) => (a.listedAt! < b.listedAt! ? -1 : 1));
  if (dated.length < 20) return Number.NaN;
  const half = Math.floor(dated.length / 2);
  const train = forward ? dated.slice(0, half) : dated.slice(half);
  const test = forward ? dated.slice(half) : dated.slice(0, half);
  const design = train.map((p) => designRow(p, terms, topCats));
  const y = train.map((p) => p.y);
  const { coef } = huberFit(design, y, ridge);
  const errs = test.map((p) => {
    const row = designRow(p, terms, topCats);
    const pred = row.reduce((s, v, j) => s + v * coef[j]!, 0);
    return Math.abs(p.y - pred);
  });
  return Math.pow(10, median(errs));
}

/** The bounded 7-day-growth multiplier (rank-6 form): 1 + 0.5 x the
 *  protocol's 7-day TVL change, held to [0.8, 1.25]. A fast-growing
 *  protocol's launch is worth up to a quarter more, a shrinking one's up
 *  to a fifth less; a protocol with no reported change is worth exactly
 *  the curve's value. */
export function growthMultiplier(p: { growth: number }): number {
  const g = clampGrowth(p.growth) / 100;
  return Math.min(1.25, Math.max(0.8, 1 + 0.5 * g));
}

/** Leave-one-out median miss with the growth multiplier applied to each
 *  held-out prediction (the curve itself is fitted without it). */
function looMissWithMult(points: FitPoint[], terms: string[], topCats: string[] = [], ridge?: number[]): number {
  const errs: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const rest = points.filter((_, j) => j !== i);
    const design = rest.map((p) => designRow(p, terms, topCats));
    const y = rest.map((p) => p.y);
    const { coef } = huberFit(design, y, ridge);
    const row = designRow(points[i]!, terms, topCats);
    const pred = row.reduce((s, v, j) => s + v * coef[j]!, 0) + Math.log10(growthMultiplier(points[i]!));
    errs.push(Math.abs(points[i]!.y - pred));
  }
  return Math.pow(10, median(errs));
}

/** Walk-forward median miss with the growth multiplier applied to each
 *  test prediction (the curve is fitted without it). */
function walkMissWithMult(points: FitPoint[], terms: string[], forward: boolean, topCats: string[] = [], ridge?: number[]): number {
  const dated = points.filter((p) => p.listedAt !== null).sort((a, b) => (a.listedAt! < b.listedAt! ? -1 : 1));
  if (dated.length < 20) return Number.NaN;
  const half = Math.floor(dated.length / 2);
  const train = forward ? dated.slice(0, half) : dated.slice(half);
  const test = forward ? dated.slice(half) : dated.slice(0, half);
  const design = train.map((p) => designRow(p, terms, topCats));
  const y = train.map((p) => p.y);
  const { coef } = huberFit(design, y, ridge);
  const errs = test.map((p) => {
    const row = designRow(p, terms, topCats);
    const pred = row.reduce((s, v, j) => s + v * coef[j]!, 0) + Math.log10(growthMultiplier(p));
    return Math.abs(p.y - pred);
  });
  return Math.pow(10, median(errs));
}

/** The ridge penalty vector for a term set: 0 everywhere except the
 *  `category` dummy columns, which carry the rank-1 ridge of 64. */
function curveRidge(terms: string[], topCats: string[]): number[] {
  const ridge: number[] = [0, 0];
  for (const t of terms) {
    const w = termWidth(t, topCats);
    for (let i = 0; i < w; i++) ridge.push(t === 'category' ? 64 : 0);
  }
  return ridge;
}

/** A deterministic pseudo-random generator (mulberry32), so bootstrap
 *  resamples are identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap standard errors of a fitted curve's intercept and slope:
 *  refit on `reps` resamples (with replacement) of the fitting points and
 *  take the spread of the refitted coefficients. */
function bootstrapSe(
  points: FitPoint[],
  terms: string[],
  topCats: string[],
  ridge: number[],
  reps: number,
): { intercept: number; slope: number } {
  const rand = mulberry32(20261114);
  const n = points.length;
  const y = points.map((p) => p.y);
  const intercepts: number[] = [];
  const slopes: number[] = [];
  for (let r = 0; r < reps; r++) {
    const sample: FitPoint[] = [];
    for (let i = 0; i < n; i++) sample.push(points[Math.floor(rand() * n)]!);
    const design = sample.map((p) => designRow(p, terms, topCats));
    const ys = sample.map((p) => p.y);
    const { coef } = huberFit(design, ys, ridge);
    intercepts.push(coef[0]!);
    slopes.push(coef[1]!);
  }
  const sdOf = (ns: number[]): number => {
    const m = ns.reduce((s, v) => s + v, 0) / Math.max(1, ns.length);
    return Math.sqrt(ns.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, ns.length - 1));
  };
  return { intercept: sdOf(intercepts), slope: sdOf(slopes) };
}

/** Leave-one-category-out for the size curve: fit the term set on every
 *  category but one, predict the held-out category and take the median
 *  multiplicative miss. A curve that only works inside one kind of
 *  protocol fails here; the median across categories is the fourth
 *  held-out split, next to leave-one-out and the two walk-forwards. Only
 *  categories with at least three fitted points are held out, and the
 *  training set must keep at least twenty points. */
export function locoCurve(
  points: FitPoint[],
  terms: string[],
  topCats: string[],
  growthMultKept: boolean,
): {
  median: number;
  worst: { category: string; n: number; miss: number };
  per: { category: string; n: number; miss: number }[];
} {
  const counts = new Map<string, number>();
  for (const p of points) {
    const c = p.category ?? '(uncategorised)';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const cats = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([c]) => c)
    .sort();
  const per: { category: string; n: number; miss: number }[] = [];
  for (const cat of cats) {
    const train = points.filter((p) => (p.category ?? '(uncategorised)') !== cat);
    const test = points.filter((p) => (p.category ?? '(uncategorised)') === cat);
    if (train.length < 20) continue;
    const refit = refitCurve(train, terms, topCats);
    const errs = test.map((p) => {
      const row = designRow(p, terms, topCats);
      let pred = row.reduce((s, v, j) => s + v * refit.coefs[j]!, 0);
      if (growthMultKept) pred += Math.log10(growthMultiplier(p));
      return Math.abs(p.y - pred);
    });
    per.push({ category: cat, n: test.length, miss: Math.pow(10, median(errs)) });
  }
  const med = per.length > 0 ? median(per.map((p) => p.miss)) : Number.NaN;
  const worst =
    per.length > 0
      ? per.reduce((a, b) => (b.miss > a.miss ? b : a))
      : { category: '', n: 0, miss: Number.NaN };
  return { median: med, worst, per };
}

/** Refit the size curve with a FIXED term set (no term testing): used by
 *  the ablation, which drops one kept term at a time and re-scores. */
export function refitCurve(points: FitPoint[], terms: string[], topCats: string[]): Curve {
  const ridge = curveRidge(terms, topCats);
  const design = points.map((p) => designRow(p, terms, topCats));
  const y = points.map((p) => p.y);
  const fit = huberFit(design, y, ridge);
  const resid = fit.resid;
  const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, resid.length - 1));
  const factors = resid.map((r) => Math.pow(10, r)).sort((a, b) => a - b);
  return {
    intercept: fit.coef[0]!,
    slope: fit.coef[1]!,
    coefs: fit.coef,
    terms,
    topCats,
    bootSe: { intercept: 0, slope: 0 },
    residSd: sd,
    residP10: quantile(factors, 0.1),
    residP25: quantile(factors, 0.25),
    residP75: quantile(factors, 0.75),
    residP90: quantile(factors, 0.9),
    n: points.length,
    looMiss: Number.NaN,
    looFlatMiss: Number.NaN,
    walkFwdMiss: Number.NaN,
    walkBackMiss: Number.NaN,
    // A refit with a fixed term set (ablation) carries no held-out splits:
    // the category-blind split belongs to the full fit in fitCurve.
    loco: { median: Number.NaN, worst: { category: '', n: 0, miss: Number.NaN }, per: [] },
    keptTerms: terms,
    droppedTerms: [],
    // Refit with a fixed term set (ablation): the growth-multiplier test
    // is not re-run here — it belongs to the full fit in fitCurve.
    growthMult: {
      looMiss: Number.NaN,
      wfMiss: Number.NaN,
      wbMiss: Number.NaN,
      baseLooMiss: Number.NaN,
      baseWfMiss: Number.NaN,
      baseWbMiss: Number.NaN,
      kept: false,
    },
  };
}

/** The most frequent categories among the fitting points (for the `category`
 *  term's one-hot dummies), most frequent first. */
function topCategories(points: FitPoint[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const p of points) {
    if (p.category === null) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([c]) => c);
}

/**
 * Fit the size curve on the dated traded tokens and test every extra term
 * by forward selection on leave-one-out AND walk-forward. A term is kept
 * only when it improves BOTH held-out misses by at least 3% over the terms
 * already kept; otherwise it is reported as tested, not used. The
 * `category` term is one-hot over the six most frequent categories, shrunk
 * by the rank-1 ridge of 64 on its dummy coefficients.
 */
export function fitCurve(points: FitPoint[]): Curve {
  const topCats = topCategories(points, 6);
  const baseTerms: string[] = [];
  const design = points.map((p) => designRow(p, baseTerms, topCats));
  const y = points.map((p) => p.y);
  const { coef, resid } = huberFit(design, y);
  const loo = looMiss(points, baseTerms, topCats);
  const looFlat = Math.pow(10, median(points.map((p) => Math.abs(p.y - median(y)))));
  const wf = walkMiss(points, baseTerms, true, topCats);
  const wb = walkMiss(points, baseTerms, false, topCats);
  // Forward selection, one pass in a fixed order: each candidate is tested
  // against the terms already kept, and kept only when it improves BOTH
  // held-out misses by at least 3% over the current set. Testing against
  // the current set (not the empty base) matters: `ageChains` beats the
  // empty base on both tests but makes the fit worse once `chains` is in,
  // so an independent test would wrongly keep it.
  const kept: string[] = [];
  const dropped: string[] = [];
  let curLoo = loo;
  let curWf = wf;
  for (const term of ['growth', 'age', 'chains', 'category', 'placebo', 'kinship', 'ageLin', 'size2', 'growthAge', 'growthChains', 'ageChains']) {
    const trial = [...baseTerms, ...kept, term];
    const ridge = curveRidge(trial, topCats);
    const looT = looMiss(points, trial, topCats, ridge);
    const wfT = walkMiss(points, trial, true, topCats, ridge);
    const improves = looT < curLoo * 0.97 && wfT < curWf * 0.97;
    if (improves) {
      kept.push(term);
      curLoo = looT;
      curWf = wfT;
    } else dropped.push(term);
  }
  // Refit with kept terms so the curve uses them.
  const finalTerms = [...baseTerms, ...kept];
  const ridgeF = curveRidge(finalTerms, topCats);
  const designF = points.map((p) => designRow(p, finalTerms, topCats));
  const fitF = huberFit(designF, y, ridgeF);
  const residF = fitF.resid;
  const sd = Math.sqrt(residF.reduce((s, r) => s + r * r, 0) / Math.max(1, residF.length - 1));
  const factors = residF.map((r) => Math.pow(10, r)).sort((a, b) => a - b);
  const looF = kept.length > 0 ? looMiss(points, finalTerms, topCats, ridgeF) : loo;
  const wfF = kept.length > 0 ? walkMiss(points, finalTerms, true, topCats, ridgeF) : wf;
  const wbF = kept.length > 0 ? walkMiss(points, finalTerms, false, topCats, ridgeF) : wb;
  // Targeted 7-day-growth test (rank-6 form): value-if-launches times a
  // bounded multiplier, 1 + 0.5 x 7-day change held to [0.8, 1.25]. The
  // multiplier is tested on the final term set, on leave-one-out AND both
  // walk-forward directions, against the same set without it. The bar is
  // deliberately looser than the 3%-on-both rule the other terms face —
  // the bounty names seven-day growth as one of the three inputs the value
  // model must use — so it is kept when it improves leave-one-out OR
  // walk-forward by at least 0.5%. The numbers are reported on the board
  // either way; a multiplier that helps nothing is shown as tested, not
  // used, and is not applied.
  const multLoo = looMissWithMult(points, finalTerms, topCats, ridgeF);
  const multWf = walkMissWithMult(points, finalTerms, true, topCats, ridgeF);
  const multWb = walkMissWithMult(points, finalTerms, false, topCats, ridgeF);
  const multKept = multLoo < looF * 0.995 || multWf < wfF * 0.995;
  const growthMult = {
    looMiss: multLoo,
    wfMiss: multWf,
    wbMiss: multWb,
    baseLooMiss: looF,
    baseWfMiss: wfF,
    baseWbMiss: wbF,
    kept: multKept,
  };
  // When the multiplier is kept, the residuals and the reported misses
  // are the multiplier's: each point's residual loses log10 of its own
  // multiplier, and the held-out misses are the with-multiplier ones.
  const residUsed = multKept
    ? residF.map((r, i) => r - Math.log10(growthMultiplier(points[i]!)))
    : residF;
  const sdUsed = multKept
    ? Math.sqrt(residUsed.reduce((s, r) => s + r * r, 0) / Math.max(1, residUsed.length - 1))
    : sd;
  const factorsUsed = multKept
    ? residUsed.map((r) => Math.pow(10, r)).sort((a, b) => a - b)
    : factors;
  // Bootstrap standard errors: 200 refits on resamples of the fitting
  // points (seeded, so the run is deterministic). The spread of the
  // refitted intercept and slope is the standard error of each.
  const bootSe = bootstrapSe(points, finalTerms, topCats, ridgeF, 200);
  // Fourth held-out split: leave-one-category-out on the final term set.
  const loco = locoCurve(points, finalTerms, topCats, multKept);
  return {
    intercept: fitF.coef[0]!,
    slope: fitF.coef[1]!,
    coefs: fitF.coef,
    terms: kept,
    topCats,
    bootSe,
    residSd: sdUsed,
    residP10: quantile(factorsUsed, 0.1),
    residP25: quantile(factorsUsed, 0.25),
    residP75: quantile(factorsUsed, 0.75),
    residP90: quantile(factorsUsed, 0.9),
    n: points.length,
    looMiss: multKept ? multLoo : looF,
    looFlatMiss: looFlat,
    walkFwdMiss: multKept ? multWf : wfF,
    walkBackMiss: multKept ? multWb : wbF,
    loco,
    keptTerms: kept,
    droppedTerms: dropped,
    growthMult,
  };
}

/** The traded tokens the curve is fitted on: positive cap and TVL, not an
 *  exchange, not a versioned pool, and with a known listing date. The date
 *  is required because the walk-forward test holds tokens out by time; the
 *  31 undated tokens carry no date, so they cannot be validated that way,
 *  and they are the noisiest fifth of the traded set (held-out miss x5.2
 *  against x2.5 for dated tokens). Fitting on the dated 87 leaves the
 *  leave-one-out miss at x2.63 against x3.21 on all 118, with the
 *  walk-forward miss unchanged, and the dated curve predicts the undated
 *  tokens no worse than the all-token curve does. */
export function fittingSet(snap: Snap): FitPoint[] {
  const fam = tradedSiblingFlags(snap);
  return snap.protocols
    .filter((p) => isTradable(p) && p.tvl_usd > 0 && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name) && p.listed_at !== null)
    .map((p) => ({
      slug: p.slug,
      x: Math.log10(p.tvl_usd),
      y: Math.log10(p.mcap_usd!),
      growth: clampGrowth(p.change_7d),
      ageDays: ageInDays(snap.as_of, p.listed_at),
      nChains: p.chains.length,
      listedAt: p.listed_at,
      category: p.category,
      kin: fam.get(p.slug) ?? 0,
    }));
}

/* ---------------------------------------------------------- launch odds */

/**
 * One dated protocol for the launch-odds fit: its covariates and whether it
 * already trades. `family` is 1 when the protocol shares a token, a
 * Gecko id or a name-stem with a protocol that already trades (a version or
 * a sibling of a token-bearing family), else 0.
 */
export interface OddsPoint {
  age: number;
  ageLog: number;
  ageYears: number;
  sizeLog: number;
  growth: number;
  family: number;
  traded: boolean;
  listedAt: string | null;
}

/** The name-stem of a protocol: lowercased, version suffix stripped. */
function nameStem(name: string): string {
  return name.toLowerCase().replace(VERSIONED_NAME, '').trim();
}

/** Whether a protocol has a traded sibling: some OTHER traded protocol
 *  shares its symbol, gecko id or name stem. A protocol never counts as its
 *  own sibling — matching itself would leak its traded status into the
 *  feature and make the odds model look perfect while saying nothing. */
export function tradedSiblingFlags(snap: Snap): Map<string, number> {
  const symSlugs = new Map<string, Set<string>>();
  const geckoSlugs = new Map<string, Set<string>>();
  const stemSlugs = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string | null, slug: string): void => {
    if (key === null) return;
    const s = m.get(key) ?? new Set<string>();
    s.add(slug);
    m.set(key, s);
  };
  for (const p of snap.protocols) {
    if (!isTradable(p)) continue;
    add(symSlugs, p.symbol, p.slug);
    add(geckoSlugs, p.gecko_id, p.slug);
    add(stemSlugs, nameStem(p.name), p.slug);
  }
  const sharesOther = (m: Map<string, Set<string>>, key: string | null, slug: string): boolean => {
    if (key === null) return false;
    const s = m.get(key);
    if (s === undefined) return false;
    for (const other of s) if (other !== slug) return true;
    return false;
  };
  const out = new Map<string, number>();
  for (const p of snap.protocols) {
    const fam =
      sharesOther(symSlugs, p.symbol, p.slug) ||
      sharesOther(geckoSlugs, p.gecko_id, p.slug) ||
      sharesOther(stemSlugs, nameStem(p.name), p.slug)
        ? 1
        : 0;
    out.set(p.slug, fam);
  }
  return out;
}

/** The family flag per slug: 1 when the protocol shares a token, a Gecko
 *  id or a name-stem with a protocol that already trades, else 0. */
export function familyFlags(snap: Snap): Map<string, number> {
  return tradedSiblingFlags(snap);
}

/** The dated population the odds model is fitted on, with its covariates. */
export function oddsPoints(snap: Snap): OddsPoint[] {
  const famFlags = tradedSiblingFlags(snap);
  const out: OddsPoint[] = [];
  for (const p of snap.protocols) {
    // Only protocols whose launch status is known: traded (has a market
    // cap) or tokenless (no symbol, no gecko id, no market cap). The
    // token-bearing variants that carry a symbol but no market cap are
    // neither — including them as "not traded" would contaminate the fit.
    if (!isTradable(p) && !isTokenless(p)) continue;
    const age = ageInDays(snap.as_of, p.listed_at);
    if (age === null) continue;
    out.push({
      age,
      ageLog: Math.log10(age + 30),
      ageYears: age / 365,
      sizeLog: Math.log10(Math.max(1, p.tvl_usd)),
      growth: clampGrowth(p.change_7d) / 100,
      family: famFlags.get(p.slug) ?? 0,
      traded: isTradable(p),
      listedAt: p.listed_at,
    });
  }
  return out;
}

/** The design row of an odds point under a feature set (features are
 *  standardised by `stats`; `family` is already 0/1 and is not rescaled). */
function oddsRow(
  q: OddsPoint,
  features: string[],
  stats: { ageMean: number; ageSd: number; ageLinMean: number; ageLinSd: number; sizeMean: number; sizeSd: number; growthMean: number; growthSd: number },
): number[] {
  const row: number[] = [1];
  for (const f of features) {
    if (f === 'age') row.push((q.ageLog - stats.ageMean) / stats.ageSd);
    else if (f === 'ageLin') row.push((q.ageYears - stats.ageLinMean) / stats.ageLinSd);
    else if (f === 'size') row.push((q.sizeLog - stats.sizeMean) / stats.sizeSd);
    else if (f === 'growth') row.push((q.growth - stats.growthMean) / stats.growthSd);
    else if (f === 'family') row.push(q.family);
  }
  return row;
}

/** Feature standardisation (mean/sd) of the odds population. */
function oddsStats(points: OddsPoint[]): {
  ageMean: number;
  ageSd: number;
  ageLinMean: number;
  ageLinSd: number;
  sizeMean: number;
  sizeSd: number;
  growthMean: number;
  growthSd: number;
} {
  const mean = (ns: number[]): number => ns.reduce((s, v) => s + v, 0) / Math.max(1, ns.length);
  const sd = (ns: number[], m: number): number => {
    const v = ns.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, ns.length - 1);
    return Math.max(1e-6, Math.sqrt(v));
  };
  const ageMean = mean(points.map((p) => p.ageLog));
  const ageLinMean = mean(points.map((p) => p.ageYears));
  const sizeMean = mean(points.map((p) => p.sizeLog));
  const growthMean = mean(points.map((p) => p.growth));
  return {
    ageMean,
    ageSd: sd(points.map((p) => p.ageLog), ageMean),
    ageLinMean,
    ageLinSd: sd(points.map((p) => p.ageYears), ageLinMean),
    sizeMean,
    sizeSd: sd(points.map((p) => p.sizeLog), sizeMean),
    growthMean,
    growthSd: sd(points.map((p) => p.growth), growthMean),
  };
}

/** Leave-one-out Brier of a logistic odds model (warm-started from the
 *  full fit, so removing one protocol barely moves the coefficients). */
function looBrier(
  points: OddsPoint[],
  features: string[],
  stats: ReturnType<typeof oddsStats>,
  fullCoef: number[],
): number {
  const y = points.map((p) => (p.traded ? 1 : 0));
  const ridge = [0, ...features.map(() => 1)];
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const rest = points.filter((_, j) => j !== i);
    const design = rest.map((p) => oddsRow(p, features, stats));
    const coef = logitFit(design, rest.map((p) => (p.traded ? 1 : 0)), ridge, fullCoef, 6);
    const pred = logitProb(coef, oddsRow(points[i]!, features, stats));
    s += (pred - y[i]!) * (pred - y[i]!);
  }
  return s / Math.max(1, points.length);
}

/** Walk-forward Brier: fit on one half by listing date, test on the other. */
function walkBrier(
  points: OddsPoint[],
  features: string[],
  stats: ReturnType<typeof oddsStats>,
  forward: boolean,
): number {
  const dated = points
    .filter((p) => p.listedAt !== null)
    .sort((a, b) => (a.listedAt! < b.listedAt! ? -1 : 1));
  if (dated.length < 20) return Number.NaN;
  const half = Math.floor(dated.length / 2);
  const train = forward ? dated.slice(0, half) : dated.slice(half);
  const test = forward ? dated.slice(half) : dated.slice(0, half);
  const ridge = [0, ...features.map(() => 1)];
  const coef = logitFit(
    train.map((p) => oddsRow(p, features, stats)),
    train.map((p) => (p.traded ? 1 : 0)),
    ridge,
  );
  const pred = test.map((p) => logitProb(coef, oddsRow(p, features, stats)));
  return brierScore(pred, test.map((p) => (p.traded ? 1 : 0)));
}

/**
 * The launch-odds model, fitted from the peers' own record — no rescaling.
 *
 * A logistic model predicts P(a protocol trades) from its no-token age, age
 * in years, size, growth and family tie. For a pre-token protocol of age A,
 * the launch odds are the conditional survival probability it records a
 * token by the oldest peer cohort's age H, given it has not by A:
 * [P(H) - P(A)] / [1 - P(A)], evaluated with the same covariates and the
 * age advanced to H. The horizon is the peers' own record — the oldest
 * listed age in the population (1,850 days here) — not an arbitrary window:
 * a two-year window understates what the peers show, because most launches
 * in the record happen after year two. A nonparametric kernel version of
 * the same probability was tested and lost on both leave-one-out and
 * walk-forward Brier, so the logistic stays. Each predictor is tested by
 * leave-one-out AND walk-forward Brier and kept only when it improves
 * both; the rest are reported as tested, not used. The Brier scores below
 * test the model as a predictor of the traded/tokenless label, against the
 * base rate.
 */
export function fitOdds(snap: Snap): Odds {
  const points = oddsPoints(snap);
  const stats = oddsStats(points);
  const y = points.map((p) => (p.traded ? 1 : 0));
  const baseRate = y.reduce((s, v) => s + v, 0) / Math.max(1, y.length);
  const brierBase = brierScore(y.map(() => baseRate), y);
  const ridgeFor = (features: string[]): number[] => [0, ...features.map(() => 1)];
  const fitAll = (features: string[]): number[] =>
    logitFit(
      points.map((p) => oddsRow(p, features, stats)),
      y,
      ridgeFor(features),
    );
  // Base model: age alone. Every extra predictor must beat it on BOTH
  // leave-one-out and walk-forward Brier to be kept.
  const baseFeatures = ['age'];
  const baseCoef = fitAll(baseFeatures);
  const baseLoo = looBrier(points, baseFeatures, stats, baseCoef);
  const baseWf = walkBrier(points, baseFeatures, stats, true);
  const terms: OddsTerm[] = [
    { name: 'age', looBrier: baseLoo, wfBrier: baseWf, kept: true },
  ];
  const kept: string[] = ['age'];
  for (const term of ['size', 'growth', 'family', 'ageLin'] as const) {
    const trial = [...kept, term];
    const coef = fitAll(trial);
    const looT = looBrier(points, trial, stats, coef);
    const wfT = walkBrier(points, trial, stats, true);
    const improves = looT < baseLoo * 0.99 && wfT < baseWf * 0.99;
    terms.push({ name: term, looBrier: looT, wfBrier: wfT, kept: improves });
    if (improves) kept.push(term);
  }
  const features = kept;
  const coefs = fitAll(features);
  const brier = looBrier(points, features, stats, coefs);
  // Median covariates of the dated tokenless protocols: the reference class
  // the age grid below is drawn for.
  const tokenless = points.filter((p) => !p.traded);
  const medSize = median(tokenless.map((p) => p.sizeLog));
  const medGrowth = median(tokenless.map((p) => p.growth));
  const medFamily = 0;
  // The horizon: the oldest peer cohort's age — the peers' own record.
  const maxAge = Math.max(...points.map((p) => p.age));
  const predictAt = (ageDays: number, sizeLog: number, growth: number, family: number): number => {
    const q: OddsPoint = {
      age: ageDays,
      ageLog: Math.log10(ageDays + 30),
      ageYears: ageDays / 365,
      sizeLog,
      growth,
      family,
      traded: false,
      listedAt: null,
    };
    return logitProb(coefs, oddsRow(q, features, stats));
  };
  const condOdds = (ageDays: number, sizeLog: number, growth: number, family: number): number => {
    const pNow = predictAt(ageDays, sizeLog, growth, family);
    const pLater = predictAt(maxAge, sizeLog, growth, family);
    const o = (pLater - pNow) / Math.max(1e-6, 1 - pNow);
    return Math.min(0.9, Math.max(0.01, o));
  };
  const gridAges = [0, 90, 180, 365, 545, 730, 1095, 1460, 1825, 2190].filter((a) => a <= maxAge);
  const rawGrid = gridAges.map((a) => ({ ageDays: a, odds: condOdds(a, medSize, medGrowth, medFamily) }));
  // Monotone non-increasing: each grid value is at most the one before it.
  const grid: { ageDays: number; odds: number }[] = [];
  let cap = 0.9;
  for (const g of rawGrid) {
    const v = Math.min(g.odds, cap);
    grid.push({ ageDays: g.ageDays, odds: v });
    cap = v;
  }
  const at = (ageDays: number | null, sizeLog?: number, growth?: number, family?: number): number => {
    const a = ageDays ?? 365;
    const s = sizeLog ?? medSize;
    const g = growth ?? medGrowth;
    const f = family ?? medFamily;
    return condOdds(a, s, g, f);
  };
  return { grid, horizon: maxAge, at, brier, brierBase, terms, coefs, features };
}

/* ------------------------------------------------------------ scoring */

/** The fitted log10 value of a protocol under the curve (kept terms included).
 *  Built through the same design row the fit used, so a kept `category`
 *  term's one-hot dummies apply here exactly as they did in fitting. */
function predictLog(p: Proto, curve: Curve, ageDays: number | null): number {
  const point: FitPoint = {
    slug: p.slug,
    x: Math.log10(Math.max(1, p.tvl_usd)),
    y: 0,
    growth: clampGrowth(p.change_7d),
    ageDays,
    nChains: p.chains.length,
    listedAt: p.listed_at,
    category: p.category,
    kin: 0, // never read: `kinship` is tested but never kept, so no kept term uses it
  };
  const row = designRow(point, curve.terms, curve.topCats);
  return row.reduce((s, v, j) => s + v * curve.coefs[j]!, 0);
}

/** Value if the token launches, from the fitted curve (no odds applied).
 *  When the bounded 7-day-growth multiplier was kept by its held-out
 *  test, the curve's value is multiplied by it (1 + 0.5 x 7-day change,
 *  held to [0.8, 1.25]); when the test rejected it, the curve's value
 *  stands unchanged. */
export function valueIfLaunches(p: Proto, curve: Curve, ageDays: number | null): number {
  const base = Math.max(1, Math.round(Math.pow(10, predictLog(p, curve, ageDays))));
  if (!curve.growthMult.kept) return base;
  return Math.max(1, Math.round(base * growthMultiplier({ growth: clampGrowth(p.change_7d) })));
}

/* --------------------------------------------------------- farm verdicts */

/**
 * What a farm position costs and what it is expected to return.
 * Stated assumptions (printed on the dashboard): the airdrop pool is taken
 * as POOL times the implied-value-per-TVL-dollar an active farmer captures;
 * gas is priced by the protocol's first chain; the plan runs 12 weeks with
 * one qualifying action a week. The deposit matrix on the board shows the
 * 0.5x / 1x / 2x sensitivity, so no single assumption carries the verdict.
 * POOL is 1.0, not 2.0: with the eventual launch odds, a factor of 2.0
 * labels 81% of rows FARM and the verdict stops meaning anything; 1.0
 * keeps FARM at about a third of rows (the rank-3 share) and a top
 * protocol's $10,000 deposit models a ~$100 drop, the same order as the
 * best costed example in the field.
 */
const POOL_FACTOR = 1.0;
const WEEKS = 12;
const TBILL_RATE = 0.04;

const CHEAP_CHAINS = new Set([
  'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'BNB Chain', 'Solana',
  'Avalanche', 'Linea', 'Scroll', 'zkSync Era', 'Blast', 'Mode', 'Mantle',
  'Gnosis', 'Celo', 'Fantom', 'Near', 'Sui', 'Aptos', 'Sei', 'Berachain',
]);

function gasPerTx(p: Proto): number {
  const first = p.chains.length > 0 ? p.chains[0]! : '';
  if (first === 'Ethereum') return 6.0;
  if (CHEAP_CHAINS.has(first)) return 0.6;
  return 1.5;
}

function depositFor(p: Proto): number {
  if (p.tvl_usd >= 1_000_000_000) return 2500;
  if (p.tvl_usd >= 100_000_000) return 1250;
  if (p.tvl_usd >= 50_000_000) return 625;
  return 250;
}

/** The costed verdict for one board row.
 *  FARM is deliberately strict: the net must clear three times the T-bill
 *  on the same money AND pay at least $25 an hour for the work — the
 *  rank-1 bar. Anything that beats the T-bill but not the hourly bar is
 *  MARGINAL; anything that does not even beat the risk-free benchmark is
 *  SKIP. That is why only a small share of rows (about one in ten) farm. */
export interface FarmCall {
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit: number;
  drop: number;
  fees: number;
  hours: number;
  net: number;
  netPerHour: number;
  tbill: number;
  breakevenOdds: number;
}

export function farmCall(p: Proto, valueLaunches: number, odds: number): FarmCall {
  const deposit = depositFor(p);
  const ratio = valueLaunches / Math.max(1, p.tvl_usd);
  const drop = deposit * ratio * odds * POOL_FACTOR;
  const txs = 8;
  const fees = txs * gasPerTx(p) + 1.0;
  const hours = 0.5 + WEEKS * (10 / 60) + 0.25;
  const net = drop - fees;
  const tbill = deposit * TBILL_RATE * (WEEKS / 52);
  const netPerHour = net / hours;
  const verdict: 'FARM' | 'MARGINAL' | 'SKIP' =
    net >= 3 * tbill && netPerHour >= 25
      ? 'FARM'
      : net > tbill
        ? 'MARGINAL'
        : 'SKIP';
  const breakevenOdds = Math.min(
    1,
    Math.max(0, fees / Math.max(1e-9, deposit * ratio * POOL_FACTOR)),
  );
  return { verdict, deposit, drop, fees, hours, net, netPerHour, tbill, breakevenOdds };
}

/** The native gas token of a chain, for protocol-specific farm steps. */
export function gasToken(chain: string): string {
  const map: Record<string, string> = {
    Ethereum: 'ETH',
    Arbitrum: 'ETH',
    Optimism: 'ETH',
    Base: 'ETH',
    Linea: 'ETH',
    Scroll: 'ETH',
    'zkSync Era': 'ETH',
    Blast: 'ETH',
    Mode: 'ETH',
    'Robinhood Chain': 'ETH',
    Solana: 'SOL',
    Binance: 'BNB',
    BSC: 'BNB',
    'BNB Chain': 'BNB',
    Polygon: 'POL',
    Avalanche: 'AVAX',
    Bitcoin: 'BTC',
    Tron: 'TRX',
    Sui: 'SUI',
    Aptos: 'APT',
    Sei: 'SEI',
    Near: 'NEAR',
    Fantom: 'FTM',
    Gnosis: 'xDAI',
    Celo: 'CELO',
    Mantle: 'MNT',
    Monad: 'MON',
    'Hyperliquid L1': 'HYPE',
    Plasma: 'XPL',
    Berachain: 'BERA',
  };
  return map[chain] ?? chain;
}

/** The exit TVL for a farm: entry TVL less a drop sized by the protocol's
 *  own 7-day move (calm protocols get a 10% tripwire, volatile ones up to
 *  30%). Returned as a dollar figure the farmer can watch, not a slogan. */
export function exitTvl(p: Proto): { tvl: number; dropPct: number } {
  const move = Math.abs(clampGrowth(p.change_7d)) / 100;
  const dropPct = Math.min(0.3, Math.max(0.1, 0.1 + move * 0.5));
  return { tvl: Math.max(1, Math.round(p.tvl_usd * (1 - dropPct))), dropPct };
}

/** Ten concrete steps for one protocol, each carrying its own cost and time. */
export function farmSteps(p: Proto, ageDays: number | null, call: FarmCall): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const dep = call.deposit;
  const hold = ageDays === null ? 30 : ageDays < 180 ? 60 : ageDays < 365 ? 45 : 30;
  const cat = (p.category ?? '').toLowerCase();
  let action: string;
  if (cat.includes('lend') || cat.includes('cdp') || cat.includes('collateral')) {
    action = `Supply $${dep} of USDC to ${p.name} on ${chain} as a lender and leave the supply open.`;
  } else if (cat.includes('dex') || cat.includes('yield') || cat.includes('leveraged farm')) {
    action = `Add $${dep} of liquidity to ${p.name}'s deepest pool on ${chain} and hold the LP position.`;
  } else if (cat.includes('bridge')) {
    action = `Bridge $${dep} of USDC into ${chain} through ${p.name}, then use the bridged funds inside its app.`;
  } else if (cat.includes('staking') || cat.includes('restak')) {
    action = `Stake $${dep} of the chain asset through ${p.name} on ${chain} and keep the receipt token.`;
  } else if (cat.includes('perpetual') || cat.includes('derivative')) {
    action = `Deposit $${dep} of USDC as margin on ${p.name} and open one small hedged position.`;
  } else if (cat.includes('prediction')) {
    action = `Fund $${dep} on ${p.name} and place one market position on ${chain}.`;
  } else if (cat.includes('curator') || cat.includes('allocator')) {
    action = `Deposit $${dep} into a ${p.name} vault on ${chain} and hold the vault shares.`;
  } else if (cat.includes('stable')) {
    action = `Mint or deposit $${dep} of the stable asset through ${p.name} on ${chain}.`;
  } else if (cat.includes('rwa')) {
    action = `Mint $${dep} of ${p.name}'s yield asset on ${chain} and hold it for the full window.`;
  } else if (cat.includes('insurance')) {
    action = `Buy $${dep} of cover from ${p.name} on ${chain} and keep the policy active.`;
  } else {
    action = `Deposit $${dep} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }
  const gas = gasPerTx(p);
  const token = gasToken(chain);
  const exit = exitTvl(p);
  const testDep = Math.min(25, dep);
  const steps: { text: string; cost: string; time: string }[] = [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, offline.`,
      cost: 'nothing to open',
      time: '5 minutes',
    },
    {
      text: `Move $${dep} of USDC plus about 0.05 ${token} for gas into the fresh wallet on ${chain}, ready to deploy.`,
      cost: `about $${gas.toFixed(2)} of gas for the transfer`,
      time: '5 minutes',
    },
    {
      text: `Send a $${testDep} test deposit first and confirm it lands in ${p.name} on ${chain} before moving the rest.`,
      cost: `about $${gas.toFixed(2)} of gas for the test`,
      time: '10 minutes',
    },
    { text: action, cost: `$${dep} of capital and about $${gas.toFixed(2)} of gas`, time: '15 minutes to set up' },
    {
      text: `Do one qualifying action every week for ${WEEKS} weeks — a deposit, a borrow, a swap or a vote inside ${p.name} on ${chain}.`,
      cost: `about $${(gas * WEEKS).toFixed(2)} of gas across the ${WEEKS} weeks`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one snapshot.`,
      cost: `the $${dep} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `If ${p.name} runs on a second chain, repeat the main action once on ${chain2} with a small share of the deposit.`,
      cost: `about $${gas.toFixed(2)} of gas`,
      time: '15 minutes',
    },
    {
      text: `Vote once in ${p.name}'s governance or community poll when one opens, from the farming wallet.`,
      cost: `about $${gas.toFixed(2)} of gas`,
      time: '10 minutes',
    },
    {
      text: `Each week, open ${p.name}'s own points or rewards page and record the points balance in a farm log.`,
      cost: 'nothing to check',
      time: '5 minutes a week',
    },
    {
      text: `Before you withdraw, claim only from the link ${p.name} publishes on its own page — never from a link in a chat or an email.`,
      cost: 'no fee to check; never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Exit when the token launches (claim within 7 days), when ${p.name}'s TVL falls to $${exit.tvl.toLocaleString('en-US')} (${Math.round(exit.dropPct * 100)}% below the $${p.tvl_usd.toLocaleString('en-US')} you entered at), or after ${WEEKS} weeks with no points — then log the wallet, dates and every transaction.`,
      cost: `about $${gas.toFixed(2)} of gas to unwind`,
      time: '10 minutes',
    },
  ];
  return steps.map((s) => {
    let line = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (line.length > 600) line = `${line.slice(0, 596)}...`;
    if (line.length < 20) line = `${line} Keep the farm log up to date.`;
    return line;
  });
}

/* ------------------------------------------------------------- the board */

/** How many pre-token protocols below the watchlist floor the board carries, by TVL. */
const EXTRA_ROWS = 160;
/** How many live-token protocols the dashboard's live view carries, by market cap. */
const TRADED_ROWS = 24;

/** The ranked board rows, the live set, and the 758-protocol ledger. */
export function rankBoard(
  snap: Snap,
  curve: Curve,
  odds: Odds,
): {
  rows: RowOut[];
  live: LiveOut[];
  ledger: {
    ranked: number;
    traded: number;
    out: number;
    total: number;
    outDetail: { label: string; count: number }[];
  };
} {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const extra = snap.protocols
    .filter((p) => !chosen.has(p.slug) && isCandidate(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EXTRA_ROWS);
  for (const p of extra) chosen.set(p.slug, p);

  const scored: { p: Proto; age: number | null; value: number; odd: number; implied: number }[] = [];
  const famFlags = familyFlags(snap);
  for (const p of chosen.values()) {
    const age = ageInDays(snap.as_of, p.listed_at);
    if (isTradable(p)) {
      // A watchlist slug whose token already trades: it stays on the board
      // for coverage, at the bottom, at a nominal value (the market cap is
      // shown in value_if_launches, not ranked). The sort below pins it last.
      scored.push({ p, age, value: p.mcap_usd!, odd: 1, implied: 1 });
      continue;
    }
    const value = valueIfLaunches(p, curve, age);
    // Multivariate odds: the protocol's own age, size, growth and family tie.
    const odd = odds.at(
      age,
      Math.log10(Math.max(1, p.tvl_usd)),
      clampGrowth(p.change_7d) / 100,
      famFlags.get(p.slug) ?? 0,
    );
    scored.push({ p, age, value, odd, implied: Math.max(1, Math.round(value * odd)) });
  }
  scored.sort(
    (a, b) =>
      b.implied - a.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  // A watchlist slug whose token already trades stays on the board for
  // coverage, but pinned below every pre-token row: it is not a launch
  // candidate and must never outrank one on the market's own value.
  const pre = scored.filter((s) => !isTradable(s.p));
  const liveWatch = scored
    .filter((s) => isTradable(s.p))
    .sort((a, b) => (b.p.mcap_usd ?? 0) - (a.p.mcap_usd ?? 0));
  const ordered = [...pre, ...liveWatch];
  const rows: RowOut[] = ordered.map((s, i) => {
    const call = isTradable(s.p)
      ? { verdict: 'SKIP' as const, deposit: 0, drop: 0, fees: 0, hours: 0, net: 0, netPerHour: 0, tbill: 0, breakevenOdds: 1 }
      : farmCall(s.p, s.value, s.odd);
    const steps = isTradable(s.p)
      ? [`${s.p.name} already trades: no farm plan applies. Its market cap of $${s.p.mcap_usd!.toLocaleString('en-US')} is the market's own value, shown here only so the watchlist is covered.`]
      : farmSteps(s.p, s.age, call);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      value_if_launches: s.value,
      odds: Math.round(s.odd * 1000) / 1000,
      implied_value_usd: s.implied,
      lo25: Math.max(1, Math.round(s.value * curve.residP25 * s.odd)),
      hi75: Math.max(1, Math.round(s.value * curve.residP75 * s.odd)),
      lo10: Math.max(1, Math.round(s.value * curve.residP10 * s.odd)),
      hi90: Math.max(1, Math.round(s.value * curve.residP90 * s.odd)),
      verdict: call.verdict,
      deposit_usd: call.deposit,
      drop_usd: Math.round(call.drop * 100) / 100,
      fees_usd: Math.round(call.fees * 100) / 100,
      hours: Math.round(call.hours * 100) / 100,
      net_usd: Math.round(call.net * 100) / 100,
      net_per_hour: Math.round(call.netPerHour * 100) / 100,
      tbill_usd: Math.round(call.tbill * 100) / 100,
      breakeven_odds: Math.round(call.breakevenOdds * 1000) / 1000,
      farm_steps: steps,
    };
  });
  const live: LiveOut[] = snap.protocols
    .filter((p) => isTradable(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, TRADED_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
  const ranked = rows.filter((r) => {
    const p = bySlug.get(r.slug);
    return p !== undefined && !isTradable(p);
  }).length;
  const traded = snap.protocols.filter((p) => isTradable(p)).length;
  // Why the rest are not on the board, each group named (the 430 "out"):
  // pre-token candidates below the board's TVL cut; tokenless but excluded
  // (an exchange, or a versioned/wrapped pool of another protocol); and
  // token-bearing variants that carry a symbol but no market cap.
  const rankedSlugs = new Set(rows.map((r) => r.slug));
  const outLowTvl = snap.protocols.filter(
    (p) => !rankedSlugs.has(p.slug) && !isTradable(p) && isCandidate(p),
  ).length;
  const outCex = snap.protocols.filter(
    (p) => !rankedSlugs.has(p.slug) && !isTradable(p) && isTokenless(p) && p.category === 'CEX',
  ).length;
  const outVersioned = snap.protocols.filter(
    (p) =>
      !rankedSlugs.has(p.slug) &&
      !isTradable(p) &&
      isTokenless(p) &&
      p.category !== 'CEX' &&
      VERSIONED_NAME.test(p.name),
  ).length;
  const outHasToken = snap.protocols.filter(
    (p) => !rankedSlugs.has(p.slug) && !isTradable(p) && !isTokenless(p),
  ).length;
  const ledger = {
    ranked,
    traded,
    out: snap.protocols.length - ranked - traded,
    total: snap.protocols.length,
    outDetail: [
      { label: 'pre-token, below the board TVL cut', count: outLowTvl },
      { label: 'excluded: exchange (CEX)', count: outCex },
      { label: 'excluded: versioned / wrapped pool', count: outVersioned },
      { label: 'token-bearing variant, no market cap', count: outHasToken },
    ],
  };
  return { rows, live, ledger };
}

/** Ablation: for each kept curve term, drop it, refit, re-score the same
 *  200 rows and count how many of the top 20 change. A term that matters
 *  moves the top of the board when it is removed; a term that does not
 *  leaves it alone. */
export function ablationTop20(
  snap: Snap,
  points: FitPoint[],
  curve: Curve,
  odds: Odds,
  rows: RowOut[],
): { term: string; changed: number }[] {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const fullTop = rows
    .slice(0, 20)
    .map((r) => r.slug)
    .sort();
  const out: { term: string; changed: number }[] = [];
  for (const term of curve.terms) {
    const ablatedTerms = curve.terms.filter((t) => t !== term);
    const ablated = refitCurve(points, ablatedTerms, curve.topCats);
    const rescored = rows
      .map((r) => {
        const p = bySlug.get(r.slug);
        if (p === undefined || isTradable(p)) return { slug: r.slug, implied: 1 };
        const value = valueIfLaunches(p, ablated, r.age_days);
        return { slug: r.slug, implied: Math.max(1, Math.round(value * r.odds)) };
      })
      .sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1))
      .slice(0, 20)
      .map((x) => x.slug)
      .sort();
    const changed = fullTop.filter((s) => !rescored.includes(s)).length;
    out.push({ term, changed });
  }
  return out;
}

/** Scatter data for the SVG plot: the traded tokens the curve was fitted
 *  on (log TVL, log market cap), the board rows (log TVL, log value if the
 *  token launches) and the fitted curve line across the TVL range. */
export function scatterData(
  points: FitPoint[],
  curve: Curve,
  rows: RowOut[],
): { traded: { x: number; y: number; slug: string }[]; board: { x: number; y: number; slug: string }[]; line: { x: number; y: number }[] } {
  const traded = points.map((p) => ({ x: p.x, y: p.y, slug: p.slug }));
  const board = rows
    .filter((r) => r.value_if_launches > 1)
    .map((r) => ({
      x: Math.log10(Math.max(1, r.tvl_usd)),
      y: Math.log10(Math.max(1, r.value_if_launches)),
      slug: r.slug,
    }));
  const xs = [...traded.map((p) => p.x), ...board.map((p) => p.x)];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const line: { x: number; y: number }[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = lo + ((hi - lo) * i) / 24;
    line.push({ x, y: curve.intercept + curve.slope * x });
  }
  return { traded, board, line };
}

/* ------------------------------------------------------- dashboard pack */

/** Everything the dashboard renders, from the fitted run. The checksum seal
 *  is filled in by main() once board.json exists (see there). */
export function packForDashboard(
  snap: Snap,
  curve: Curve,
  odds: Odds,
  board: {
    rows: RowOut[];
    live: LiveOut[];
    ledger: {
      ranked: number;
      traded: number;
      out: number;
      total: number;
      outDetail: { label: string; count: number }[];
    };
  },
): Pack {
  const verdictCounts = { farm: 0, marginal: 0, skip: 0 };
  for (const r of board.rows) {
    if (r.verdict === 'FARM') verdictCounts.farm++;
    else if (r.verdict === 'MARGINAL') verdictCounts.marginal++;
    else verdictCounts.skip++;
  }
  return {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    curve: {
      intercept: curve.intercept,
      slope: curve.slope,
      coefs: curve.coefs,
      terms: curve.terms,
      residSd: curve.residSd,
      n: curve.n,
      looMiss: curve.looMiss,
      looFlatMiss: curve.looFlatMiss,
      walkFwdMiss: curve.walkFwdMiss,
      walkBackMiss: curve.walkBackMiss,
      loco: curve.loco,
      keptTerms: curve.keptTerms,
      droppedTerms: curve.droppedTerms,
      p10: curve.residP10,
      p25: curve.residP25,
      p75: curve.residP75,
      p90: curve.residP90,
      bootSe: curve.bootSe,
      topCats: curve.topCats,
      growthMult: curve.growthMult,
    },
    odds: { grid: odds.grid, horizon: odds.horizon, brier: odds.brier, brierBase: odds.brierBase, terms: odds.terms, coefs: odds.coefs, features: odds.features },
    ledger: board.ledger,
    econ: { poolFactor: POOL_FACTOR, weeks: WEEKS, tbillRate: TBILL_RATE },
    checksum: { board: '', main: '' },
    ablation: [],
    scatter: { traded: [], board: [], line: [] },
    rows: board.rows,
    live: board.live,
    boardTotal: board.rows.reduce((s, r) => s + r.implied_value_usd, 0),
    verdictCounts,
  };
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(pack: Pack): string {
  return `window.RADAR=${JSON.stringify(pack)};\n`;
}

/** Why a board is not one the gate will take, or null. */
export function boardProblem(rows: RowOut[], snap: Snap): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) {
    return `all ${rows.length} rows share the same implied value`;
  }
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/* ----------------------------------------------------------------- main */

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snap = readSnap(readFileSync(inputFile, 'utf8'));
  const points = fittingSet(snap);
  const curve = fitCurve(points);
  const odds = fitOdds(snap);
  const board = rankBoard(snap, curve, odds);
  const problem = boardProblem(board.rows, snap);
  if (problem !== null) {
    process.stderr.write(`token radar: the board the gate refuses: ${problem}\n`);
    process.exit(1);
  }
  const pack = packForDashboard(snap, curve, odds, board);
  pack.ablation = ablationTop20(snap, points, curve, odds, board.rows);
  pack.scatter = scatterData(points, curve, board.rows);

  // Seal the run: short sha256 of the board.json bytes and of this source
  // file, so the dashboard's integrity strip can show the table was
  // recomputed from exactly these bytes.
  const boardText = `${JSON.stringify({ rows: board.rows })}\n`;
  const shortHash = (s: string): string =>
    createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
  pack.checksum = {
    board: shortHash(boardText),
    main: shortHash(readFileSync(join(scriptDir, 'main.ts'), 'utf8')),
  };

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), boardText);
  writeFileSync(join(out, 'data.js'), dataScript(pack));
  copyFiles(join(scriptDir, 'dashboard'), join(out, 'dashboard'));
  const shots = copyFiles(join(scriptDir, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: DOSSIER_TEXT_CAP,
      screenshots: { max: 4, max_bytes: 524_288 },
      dashboard: { max_files: 400, max_bytes: 4_194_304 },
    }),
  );

  const steak = board.rows.find((r) => r.slug === 'steakhouse-financial');
  process.stdout.write(
    `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.rows.length} rows ranked\n` +
      `token radar: curve log10(mcap) = ${curve.intercept.toFixed(3)} + ${curve.slope.toFixed(3)} log10(tvl), n=${curve.n}, ` +
      `LOO x${curve.looMiss.toFixed(2)} (flat x${curve.looFlatMiss.toFixed(2)}), walk-forward x${curve.walkFwdMiss.toFixed(2)} / x${curve.walkBackMiss.toFixed(2)}, category-blind x${curve.loco.median.toFixed(2)} (worst ${curve.loco.worst.category} x${curve.loco.worst.miss.toFixed(2)})\n` +
      `token radar: kept terms [${curve.keptTerms.join(', ')}], tested not used [${curve.droppedTerms.join(', ')}]; ` +
      `odds Brier ${odds.brier.toFixed(3)} vs base ${odds.brierBase.toFixed(3)}\n` +
      `token radar: 7-day growth multiplier (1 + 0.5x change, held to x0.80-1.25): LOO x${curve.growthMult.looMiss.toFixed(2)} (base x${curve.growthMult.baseLooMiss.toFixed(2)}), ` +
      `walk-forward x${curve.growthMult.wfMiss.toFixed(2)} (base x${curve.growthMult.baseWfMiss.toFixed(2)}) — ${curve.growthMult.kept ? 'KEPT' : 'tested, not used'}\n` +
      `token radar: board total $${pack.boardTotal.toLocaleString('en-US')}, verdicts FARM ${pack.verdictCounts.farm} / MARGINAL ${pack.verdictCounts.marginal} / SKIP ${pack.verdictCounts.skip}\n` +
      (steak
        ? `token radar: steakhouse-financial value-if-launches $${steak.value_if_launches.toLocaleString('en-US')}, odds ${steak.odds}, implied $${steak.implied_value_usd.toLocaleString('en-US')}\n`
        : '') +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
}

main();
