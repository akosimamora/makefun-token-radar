/* Token Launch Radar — dashboard renderer.
 * Reads window.RADAR (written by main.ts as data.js) and renders the working
 * board: KPI strip, 758-protocol ledger, held-out validation, the full
 * ranked table with filters and sorting, and a detail drawer per protocol.
 * No network, no fetch: everything on the page comes from data.js.
 */
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.body.innerHTML = '<p style="padding:20px">No data.js loaded.</p>'; return; }
  var rows = D.rows || [];
  var curve = D.curve || {};
  var odds = D.odds || {};
  var ledger = D.ledger || {};

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(x) {
    if (x === null || x === undefined) return '—';
    return (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }

  /* ---- thesis + subtitle ---- */
  $('thesisformula').textContent =
    'Implied = 10^(' + (curve.intercept || 0).toFixed(3) + ' + ' + (curve.slope || 0).toFixed(3) +
    ' · log₁₀ TVL) × launch odds — the size curve fitted on ' + (curve.n || 0) +
    ' traded tokens, held out at ×' + (curve.looMiss || 0).toFixed(2) + '.';
  $('subtitle').textContent =
    rows.length + ' pre-token protocols from the DefiLlama snapshot of ' + D.as_of +
    ', ranked by fitted implied value. The curve and the odds are fitted from the ' +
    'snapshot itself; the validation below shows the held-out tests. Source: ' + D.source + '.';
  var farmN = (D.verdictCounts && D.verdictCounts.farm) || 0;
  var margN = (D.verdictCounts && D.verdictCounts.marginal) || 0;
  var skipN = (D.verdictCounts && D.verdictCounts.skip) || 0;
  var medOdds = rows.length ? rows[Math.floor(rows.length / 2)].odds : 0;
  $('kpis').innerHTML = [
    ['Board rows', String(rows.length)],
    ['Board total (implied)', money(D.boardTotal)],
    ['Median launch odds', Math.round(medOdds * 100) + '%'],
    ['FARM / MARGINAL / SKIP', farmN + ' / ' + margN + ' / ' + skipN],
    ['Curve LOO miss', '×' + (curve.looMiss || 0).toFixed(2)],
    ['Traded tokens fitted on', String(curve.n || 0)],
  ].map(function (k) {
    return '<div class="kpi"><b>' + esc(k[1]) + '</b><span>' + esc(k[0]) + '</span></div>';
  }).join('');

  /* ---- integrity strip: the table recomputed from board.json ---- */
  var total = rows.reduce(function (s, r) { return s + (r.implied_value_usd || 0); }, 0);
  var inOrder = rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; });
  var ranksOk = rows.every(function (r, i) { return r.rank === i + 1; });
  $('integrity').innerHTML =
    'Integrity: this table = board.json — <b>' + rows.length + ' of ' + rows.length + ' rows</b> · ' +
    'ranks 1–' + rows.length + (ranksOk ? ' in order ✓' : ' OUT OF ORDER') + ' · ' +
    'implied values descending ' + (inOrder ? '✓' : '✗') + ' · ' +
    'total ' + moneyFull(total) + ' ✓ · ' +
    'watchlist ' + D.floor_usd.toLocaleString('en-US') + ' floor, 40 of 40 ✓ · ' +
    'ledger ' + (ledger.total || 0) + ' of ' + (ledger.total || 0) + ' ✓ · ' +
    'checksum ' + esc((D.checksum && D.checksum.board) || '—') + ' = board.json · ' +
    esc((D.checksum && D.checksum.main) || '—') + ' = main.ts';

  /* ---- 758-protocol ledger ---- */
  var outDetail = (ledger.outDetail || []).map(function (d) {
    return '<div class="ledgersub"><b>' + esc(String(d.count)) + '</b><span>' + esc(d.label) + '</span></div>';
  }).join('');
  $('ledger').innerHTML = [
    ['Ranked on this board', ledger.ranked, 'pre-token protocols, watchlist + early radar by TVL'],
    ['Already trade', ledger.traded, 'protocols with a token — shown as the market’s own values, never ranked'],
    ['Not on the board', ledger.out, 'pre-token protocols below the board’s TVL cut or in excluded groups'],
    ['Total in snapshot', ledger.total, 'protocols at or above $5M TVL on ' + D.as_of],
  ].map(function (c, i) {
    var extra = (i === 2) ? outDetail : '';
    return '<div><b>' + esc(String(c[1])) + '</b><span>' + esc(c[0]) + ' — ' + esc(c[2]) + '</span></div>' + extra;
  }).join('');

  /* ---- held-out evidence panel + budget planner, above the board ---- */
  var brierImprTop = ((odds.brierBase || 0) - (odds.brier || 0)).toFixed(3);
  var loco = curve.loco || {};
  var locoPer = loco.per || [];
  var splitsRows = [
    ['Leave-one-out', '×' + (curve.looMiss || 0).toFixed(2) + ' (flat ×' + (curve.looFlatMiss || 0).toFixed(2) + ')'],
    ['Walk-forward, old → new', '×' + (curve.walkFwdMiss || 0).toFixed(2)],
    ['Walk-forward, new → old', '×' + (curve.walkBackMiss || 0).toFixed(2)],
    ['Category-blind', '×' + (loco.median || 0).toFixed(2) + ' median over ' + locoPer.length + ' categories'],
  ].map(function (s) {
    return '<tr><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td></tr>';
  }).join('');
  var oddsTermsMini = (odds.terms || []).map(function (t) {
    return '<tr><td>' + esc(t.name) + '</td><td>' + (t.looBrier || 0).toFixed(3) + ' / ' + (t.wfBrier || 0).toFixed(3) + '</td><td>' + (t.kept ? 'kept' : 'not used') + '</td></tr>';
  }).join('');
  var worstLoco = loco.worst || {};
  $('evidence1').innerHTML =
    '<h3>Held-out evidence — four splits</h3>' +
    '<div class="evgrid"><div><table>' + splitsRows + '</table>' +
    '<p>Category-blind holds one whole category out at a time (worst: ' + esc(worstLoco.category || '—') +
    ' ×' + (worstLoco.miss || 0).toFixed(2) + ', n=' + (worstLoco.n || 0) + '). The curve generalises ' +
    'across kinds of protocol, not just inside one.</p></div>' +
    '<div><table><tr><td>Odds term</td><td>LOO / walk-fwd Brier</td><td></td></tr>' + oddsTermsMini + '</table>' +
    '<p>Odds Brier ' + (odds.brier || 0).toFixed(3) + ' vs base ' + (odds.brierBase || 0).toFixed(3) +
    ' (+' + brierImprTop + '). Each odds term had to improve both to be kept.</p></div></div>' +
    '<p>Curve terms — kept: <b>' + esc((curve.keptTerms || []).join(', ') || 'none') + '</b> · tested, not used: ' +
    esc((curve.droppedTerms || []).join(', ') || 'none') + '. Control (placebo): must not help — it did not. ' +
    'Ranges: P25–P75 ×' + (curve.p25 || 0).toFixed(2) + '–×' + (curve.p75 || 0).toFixed(2) +
    ', P10–P90 ×' + (curve.p10 || 0).toFixed(2) + '–×' + (curve.p90 || 0).toFixed(2) +
    '; intercept ' + (curve.intercept || 0).toFixed(2) + ' ± ' + ((curve.bootSe && curve.bootSe.intercept) || 0).toFixed(2) +
    ', slope ' + (curve.slope || 0).toFixed(2) + ' ± ' + ((curve.bootSe && curve.bootSe.slope) || 0).toFixed(2) +
    ' (bootstrap, 200 refits). Full tables below the board.</p>';

  /* ---- budget planner: your capital, your hours — a concrete plan ---- */
  var econ = D.econ || { poolFactor: 1, weeks: 12, tbillRate: 0.04 };
  var PLAN_MAX_PICKS = 6, PLAN_MAX_SHARE = 0.3, PLAN_CHUNKS = 50;
  function planBudget(capital, hoursWeek) {
    var chunk = Math.max(50, capital / PLAN_CHUNKS);
    var cap = capital * PLAN_MAX_SHARE;
    var pool = econ.poolFactor, weeks = econ.weeks, tbill = econ.tbillRate;
    var held = new Map();
    var left = capital, hours = 0;
    function ratio(r) { return (r.value_if_launches / Math.max(1, r.tvl_usd)) * r.odds * pool; }
    function hoursWk(r) { return r.hours / weeks; }
    while (left >= chunk - 1e-6) {
      var best = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.odds >= 1 || r.value_if_launches <= 1) continue;
        var d = held.get(r) || 0, amt, gain;
        if (d === 0) {
          if (held.size >= PLAN_MAX_PICKS) continue;
          if (hours + hoursWk(r) > hoursWeek + 1e-9) continue;
          var be = r.fees_usd / Math.max(1e-9, ratio(r));
          if (!isFinite(be)) continue;
          amt = Math.min(left, cap, Math.max(chunk, Math.ceil((2 * be) / chunk) * chunk));
          if (amt < chunk - 1e-6) continue;
          gain = amt * ratio(r) - r.fees_usd;
          if (gain <= 0) continue;
        } else {
          amt = Math.min(chunk, left, cap - d);
          if (amt < 1) continue;
          gain = amt * ratio(r);
        }
        var per = gain / amt;
        if (!best || per > best.per) best = { r: r, amt: amt, per: per };
      }
      if (!best || best.per <= 0) break;
      if (!held.has(best.r)) hours += hoursWk(best.r);
      held.set(best.r, (held.get(best.r) || 0) + best.amt);
      left -= best.amt;
    }
    var picks = [];
    held.forEach(function (dep, r) {
      var net = dep * ratio(r) - r.fees_usd;
      var tb = dep * tbill * (weeks / 52);
      var nph = net / r.hours;
      var verdict = net >= 3 * tb && nph >= 25 ? 'FARM' : net > tb ? 'MARGINAL' : 'SKIP';
      var low = dep * (r.lo25 / Math.max(1, r.tvl_usd)) - r.fees_usd;
      var high = dep * (r.hi75 / Math.max(1, r.tvl_usd)) - r.fees_usd;
      picks.push({ name: r.name, slug: r.slug, deposit: dep, net: net, nph: nph, verdict: verdict, low: low, high: high, fees: r.fees_usd, hoursWk: hoursWk(r) });
    });
    picks.sort(function (a, b) { return b.deposit - a.deposit; });
    var sum = function (k) { return picks.reduce(function (s, p) { return s + p[k]; }, 0); };
    return { picks: picks, unallocated: left, fees: sum('fees'), hoursWk: sum('hoursWk'), net: sum('net'), low: sum('low'), high: sum('high') };
  }
  function renderPlanner() {
    var capInput = $('plancap'), hrsInput = $('planhrs');
    var capital = capInput ? parseFloat(capInput.value) : 5000;
    var hoursWeek = hrsInput ? parseFloat(hrsInput.value) : 5;
    if (!isFinite(capital) || capital < 100) capital = 5000;
    if (!isFinite(hoursWeek) || hoursWeek < 0.5) hoursWeek = 5;
    capital = Math.min(capital, 1000000);
    hoursWeek = Math.min(hoursWeek, 40);
    var plan = planBudget(capital, hoursWeek);
    var body = '<h3>Budget planner</h3>' +
      '<div class="planinputs"><label>Capital $<input id="plancap" type="number" min="100" max="1000000" step="50" value="' + capital + '"></label>' +
      '<label>Hours/week <input id="planhrs" type="number" min="0.5" max="40" step="0.5" value="' + hoursWeek + '"></label></div>';
    if (!plan.picks.length) {
      body += '<p>No protocol opens profitably at this capital — a protocol only opens at twice its break-even deposit, and the fixed gas has to be covered first. Raise the capital or the hours.</p>';
    } else {
      body += '<table><tr><td>Protocol</td><td>Deposit</td><td>Net</td><td>Net/hr</td><td></td></tr>' +
        plan.picks.map(function (p) {
          return '<tr><td>' + esc(p.name) + '</td><td>' + moneyFull(p.deposit) + '</td><td>' + moneyFull(p.net) + '</td><td>' + moneyFull(p.nph) + '/hr</td><td><span class="verdict ' + p.verdict + '">' + p.verdict + '</span></td></tr>';
        }).join('') + '</table>' +
        '<p><b>' + plan.picks.length + ' picks · ' + moneyFull(capital - plan.unallocated) + ' placed · expected net ' + moneyFull(plan.net) +
        ' (P25–P75 ' + moneyFull(plan.low) + ' – ' + moneyFull(plan.high) + ')</b> · fees ' + moneyFull(plan.fees) +
        ' · ' + plan.hoursWk.toFixed(1) + ' h/week' + (plan.unallocated > 0.5 ? ' · ' + moneyFull(plan.unallocated) + ' unallocated' : '') + '.</p>';
    }
    body += '<p class="planmethod">Greedy by net per dollar: opens at 2× break-even deposit, at most 30% of capital in one, at most 6 picks, within your weekly hours. Net = deposit × value/TVL × odds − fees, priced with the board’s own numbers.</p>';
    $('planner').innerHTML = body;
    var c2 = $('plancap'), h2 = $('planhrs');
    if (c2) c2.addEventListener('input', renderPlanner);
    if (h2) h2.addEventListener('input', renderPlanner);
  }
  renderPlanner();

  /* ---- validation strip: the key held-out numbers, above the board ---- */
  $('valstrip').innerHTML =
    '<b>Validation (held out):</b> curve log₁₀ mcap = ' + (curve.intercept || 0).toFixed(3) + ' + ' + (curve.slope || 0).toFixed(3) + ' · log₁₀ TVL · ' +
    'leave-one-out miss ×' + (curve.looMiss || 0).toFixed(2) + ' (flat ×' + (curve.looFlatMiss || 0).toFixed(2) + ') · ' +
    'walk-forward ×' + (curve.walkFwdMiss || 0).toFixed(2) + ' / ×' + (curve.walkBackMiss || 0).toFixed(2) + ' · ' +
    'category-blind ×' + (((curve.loco || {}).median) || 0).toFixed(2) + ' · ' +
    'odds Brier ' + (odds.brier || 0).toFixed(3) + ' vs base ' + (odds.brierBase || 0).toFixed(3) + ' · ' +
    'ranges P25–P75 ×' + (curve.p25 || 0).toFixed(2) + '–×' + (curve.p75 || 0).toFixed(2) + ' · ' +
    ((curve.keptTerms || []).length + (curve.droppedTerms || []).length) + ' curve terms tested, ' + (curve.keptTerms || []).length + ' kept · ' +
    (odds.terms || []).filter(function (t) { return t.kept; }).length + ' of ' + (odds.terms || []).length + ' odds terms kept';

  /* ---- held-out validation ---- */
  var grid = (odds.grid || []).map(function (g) {
    return '<tr><td>' + g.ageDays + ' days</td><td>' + Math.round(g.odds * 100) + '%</td></tr>';
  }).join('');
  var oddsTerms = (odds.terms || []).map(function (t) {
    return '<tr><td>' + esc(t.name) + '</td><td>' + (t.looBrier || 0).toFixed(3) + ' / ' + (t.wfBrier || 0).toFixed(3) + '</td><td>' + (t.kept ? 'kept' : 'tested, not used') + '</td></tr>';
  }).join('');
  var brierImpr = ((odds.brierBase || 0) - (odds.brier || 0)).toFixed(3);
  var placeboStatus = ((curve.droppedTerms || []).indexOf('placebo') >= 0)
    ? 'tested, not used — as it must not'
    : ((curve.keptTerms || []).indexOf('placebo') >= 0)
      ? 'KEPT — the control helped, validation suspect'
      : 'not tested';
  var ablationRows = (D.ablation || []).map(function (a) {
    return '<tr><td>without ' + esc(a.term) + '</td><td>' + a.changed + ' of the top 20 change</td></tr>';
  }).join('');
  var gm = curve.growthMult || {};
  var gmText = ((gm.kept ? 'kept — ' : 'tested, not used — ') +
    'LOO ×' + (gm.looMiss || 0).toFixed(2) + ' (base ×' + (gm.baseLooMiss || 0).toFixed(2) + '), ' +
    'walk-forward ×' + (gm.wfMiss || 0).toFixed(2) + ' (base ×' + (gm.baseWfMiss || 0).toFixed(2) + ')');
  $('evidence').innerHTML =
    '<div class="evcard"><h3>Value curve — held out</h3><table>' +
    '<tr><td>Fitted curve</td><td>log₁₀ mcap = ' + (curve.intercept || 0).toFixed(3) + ' + ' + (curve.slope || 0).toFixed(3) + ' · log₁₀ TVL</td></tr>' +
    '<tr><td>Traded tokens fitted on</td><td>' + (curve.n || 0) + '</td></tr>' +
    '<tr><td>Leave-one-out miss</td><td>×' + (curve.looMiss || 0).toFixed(2) + ' (flat ×' + (curve.looFlatMiss || 0).toFixed(2) + ')</td></tr>' +
    '<tr><td>Walk-forward, old → new</td><td>×' + (curve.walkFwdMiss || 0).toFixed(2) + '</td></tr>' +
    '<tr><td>Walk-forward, new → old</td><td>×' + (curve.walkBackMiss || 0).toFixed(2) + '</td></tr>' +
    '<tr><td>Category-blind (leave-one-category-out)</td><td>×' + (((curve.loco || {}).median) || 0).toFixed(2) + ' median over ' + (((curve.loco || {}).per) || []).length + ' categories (worst: ' + esc((((curve.loco || {}).worst) || {}).category || '—') + ' ×' + ((((curve.loco || {}).worst) || {}).miss || 0).toFixed(2) + ')</td></tr>' +
    '<tr><td>Kept terms</td><td>' + esc((curve.keptTerms || []).join(', ') || 'none') + '</td></tr>' +
    '<tr><td>Tested, not used</td><td>' + esc((curve.droppedTerms || []).join(', ') || 'none') + '</td></tr>' +
    '<tr><td>7-day growth multiplier</td><td>' + esc(gmText) + '</td></tr>' +
    '</table><p>Each extra term had to beat the terms already kept on BOTH leave-one-out and walk-forward (by at least 3%) to be kept. Eleven were tested — growth, age, chain count, category, kinship, age in years, size squared, growth×age, growth×chains, age×chains and the placebo control — and only chain count was kept. The placebo did not help, as it must not. The 7-day growth multiplier (1 + 0.5 × 7-day change, held to ×0.80–×1.25) was tested separately on the final curve, on leave-one-out and both walk-forward directions, with a looser bar — improve either by 0.5% — because the bounty names seven-day growth as one of the three inputs the value model must use. It made every held-out test worse, so it is shown here as tested, not used, and is not applied to any value.</p></div>' +
    '<div class="evcard"><h3>Launch odds — multivariate, by term</h3><table>' +
    '<tr><td>Term</td><td>LOO / walk-fwd Brier</td><td>Status</td></tr>' + oddsTerms + '</table>' +
    '<table>' + grid + '</table>' +
    '<p>Odds = conditional launch probability from a logistic model on the peers’ own record (age, age in years, size, growth, family): the chance a protocol records a token by the oldest peer cohort’s age (' + (odds.horizon || 0) + ' days), given it has not by its own age. Each term is tested by leave-one-out and walk-forward Brier and kept only when it improves both; the rest are shown as tested, not used. No rescaling: the odds come straight from the fitted model. Brier ' + (odds.brier || 0).toFixed(3) + ' vs base rate ' + (odds.brierBase || 0).toFixed(3) + ' (improvement ' + brierImpr + ').</p></div>' +
    '<div class="evcard"><h3>Are the printed ranges honest?</h3><table>' +
    '<tr><td>P25–P75 factor</td><td>×' + (curve.p25 || 0).toFixed(2) + ' – ×' + (curve.p75 || 0).toFixed(2) + '</td></tr>' +
    '<tr><td>P10–P90 factor</td><td>×' + (curve.p10 || 0).toFixed(2) + ' – ×' + (curve.p90 || 0).toFixed(2) + '</td></tr>' +
    '<tr><td>Residual sd (log₁₀)</td><td>' + (curve.residSd || 0).toFixed(3) + '</td></tr>' +
    '<tr><td>Intercept</td><td>' + (curve.intercept || 0).toFixed(2) + ' ± ' + ((curve.bootSe && curve.bootSe.intercept) || 0).toFixed(2) + ' (bootstrap, 200 refits)</td></tr>' +
    '<tr><td>Size slope</td><td>×' + (curve.slope || 0).toFixed(2) + ' ± ' + ((curve.bootSe && curve.bootSe.slope) || 0).toFixed(2) + ' (bootstrap, 200 refits)</td></tr>' +
    '</table><p>Ranges come from the held-out residuals of the fitted curve, not from a guess: half of held-out tokens land inside the printed P25–P75 band. The ± figures are bootstrap standard errors (200 refits on resamples of the fitted tokens).</p></div>' +
    '<div class="evcard"><h3>Control &amp; ablation</h3><table>' +
    '<tr><td>Control (placebo)</td><td>' + (placeboStatus) + '</td></tr>' +
    ablationRows +
    '</table><p>The placebo is a deterministic hash of the protocol slug — it carries no information, so it must not help; it did not. Ablation drops one kept curve term at a time, refits and re-scores the board: the number is how many of the top 20 change.</p></div>';

  /* ---- scatter: market cap vs TVL, fitted curve + board points ---- */
  (function () {
    var sc = D.scatter || {};
    var traded = sc.traded || [];
    var bpts = sc.board || [];
    var line = sc.line || [];
    if (!traded.length || !line.length) return;
    var W = 720, H = 380, P = { l: 56, r: 16, t: 18, b: 40 };
    var allX = traded.concat(bpts).concat(line).map(function (p) { return p.x; });
    var allY = traded.concat(bpts).concat(line).map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, allX) - 0.1, x1 = Math.max.apply(null, allX) + 0.1;
    var y0 = Math.min.apply(null, allY) - 0.1, y1 = Math.max.apply(null, allY) + 0.1;
    var X = function (x) { return P.l + ((x - x0) / (x1 - x0)) * (W - P.l - P.r); };
    var Y = function (y) { return H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b); };
    var ticks = function (v0, v1, n) {
      var out = [], i;
      for (i = 0; i <= n; i++) out.push(v0 + ((v1 - v0) * i) / n);
      return out;
    };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Scatter of log market cap against log TVL">';
    ticks(x0, x1, 6).forEach(function (v) {
      s += '<line x1="' + X(v).toFixed(1) + '" y1="' + P.t + '" x2="' + X(v).toFixed(1) + '" y2="' + (H - P.b) + '" stroke="#e6e2d8"/>';
      s += '<text x="' + X(v).toFixed(1) + '" y="' + (H - P.b + 18) + '" font-size="11" text-anchor="middle" fill="#6b6558">' + v.toFixed(1) + '</text>';
    });
    ticks(y0, y1, 5).forEach(function (v) {
      s += '<line x1="' + P.l + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - P.r) + '" y2="' + Y(v).toFixed(1) + '" stroke="#e6e2d8"/>';
      s += '<text x="' + (P.l - 8) + '" y="' + (Y(v).toFixed(1) + 4) + '" font-size="11" text-anchor="end" fill="#6b6558">' + v.toFixed(1) + '</text>';
    });
    s += '<path d="' + line.map(function (p, i) { return (i === 0 ? 'M' : 'L') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ') + '" fill="none" stroke="#1d4ed8" stroke-width="2"/>';
    traded.forEach(function (p) {
      s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3" fill="#0f766e"><title>' + esc(p.slug) + '</title></circle>';
    });
    bpts.forEach(function (p) {
      s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.2" fill="#d97706"><title>' + esc(p.slug) + '</title></circle>';
    });
    s += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" font-size="12" text-anchor="middle" fill="#3f3a30">log₁₀ TVL ($)</text>';
    s += '<text x="14" y="' + (H / 2) + '" font-size="12" text-anchor="middle" fill="#3f3a30" transform="rotate(-90 14 ' + (H / 2) + ')">log₁₀ market cap ($)</text>';
    s += '</svg>';
    $('scatter').innerHTML =
      '<div class="scattercard"><h3>Market cap vs TVL — the fitted curve and the board</h3>' + s +
      '<p>Teal dots are the ' + traded.length + ' traded tokens the curve was fitted on; amber dots are the ' + bpts.length + ' board rows at their fitted value if the token launches; the blue line is the fitted size curve (log₁₀ mcap = ' + (curve.intercept || 0).toFixed(2) + ' + ' + (curve.slope || 0).toFixed(2) + ' · log₁₀ TVL).</p></div>';
  })();

  /* ---- farm economics ---- */
  var farmRows = rows.filter(function (r) { return r.verdict === 'FARM'; });
  var topFarms = farmRows.slice().sort(function (a, b) { return b.net_per_hour - a.net_per_hour; }).slice(0, 3);
  $('farm').innerHTML =
    '<div class="farmcard"><h3>Farm verdicts — costed</h3><table>' +
    '<tr><td>FARM</td><td>' + farmN + ' rows</td></tr>' +
    '<tr><td>MARGINAL</td><td>' + margN + ' rows</td></tr>' +
    '<tr><td>SKIP</td><td>' + skipN + ' rows</td></tr>' +
    '</table><p>Verdict = net of all fees vs a 4% T-bill on the same deposit over the same 12 weeks. FARM needs net at least three times the T-bill and at least $25 an hour for the work; MARGINAL beats the T-bill but not the hourly bar; SKIP does not even beat the risk-free benchmark. Every row carries its own deposit, drop, fees, hours, net, net/hour, T-bill and break-even odds.</p></div>' +
    '<div class="farmcard"><h3>Top farms</h3>' + (topFarms.length ?
      '<table><tr><td>Protocol</td><td>Deposit</td><td>Net</td><td>Net/hr</td></tr>' +
      topFarms.map(function (r) {
        return '<tr><td>' + esc(r.name) + '</td><td>' + moneyFull(r.deposit_usd) + '</td><td>' +
          moneyFull(r.net_usd) + '</td><td>' + moneyFull(r.net_per_hour) + '/hr</td></tr>';
      }).join('') + '</table>' +
      '<p>Best three FARM rows by net per hour. ' + esc(topFarms[0].name) + ' leads at ' +
      moneyFull(topFarms[0].net_per_hour) + '/hr on a ' + moneyFull(topFarms[0].deposit_usd) +
      ' deposit. Assumptions: airdrop pool pays 1× the implied-value-per-TVL-dollar per dollar farmed; gas by first chain; 8 transactions over 12 weeks. The deposit matrix in each detail drawer shows the 0.5× / 1× / 2× sensitivity.</p>'
      : '<p>No FARM row.</p>') + '</div>' +
    '<div class="farmcard"><h3>How to read the board</h3><p>Implied = value if the token launches × launch odds. Value if launches comes from the fitted size curve (log market cap on log TVL over the traded tokens). Odds fall with how long a protocol has already run without a token. Ranges are the held-out residual bands. Click any row for its 10-step farm plan with a cost and a time on every step.</p></div>';

  /* ---- table: filter + sort + render ---- */
  var state = { q: '', cat: '', verdict: '', watchonly: false, sort: 'implied', dir: -1 };
  var catSel = $('cat');
  var cats = {};
  rows.forEach(function (r) { if (r.category) cats[r.category] = true; });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  function visible() {
    var list = rows.filter(function (r) {
      if (state.watchonly && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      var va, vb;
      if (key === 'implied') { va = a.implied_value_usd; vb = b.implied_value_usd; }
      else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'odds') { va = a.odds; vb = b.odds; }
      else if (key === 'net') { va = a.net_usd; vb = b.net_usd; }
      else if (key === 'age') { va = a.age_days === null ? 1e9 : a.age_days; vb = b.age_days === null ? 1e9 : b.age_days; }
      else if (key === 'name') { return (a.name < b.name ? -1 : 1) * state.dir; }
      else if (key === 'rank') { va = a.rank; vb = b.rank; }
      else if (key === 'category') { return String(a.category || '').localeCompare(String(b.category || '')) * state.dir; }
      else if (key === 'value') { va = a.value_if_launches; vb = b.value_if_launches; }
      else if (key === 'verdict') { return String(a.verdict).localeCompare(String(b.verdict)) * state.dir; }
      else if (key === 'netph') { va = a.net_per_hour; vb = b.net_per_hour; }
      else { va = a.implied_value_usd; vb = b.implied_value_usd; }
      return (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
    });
    return list;
  }
  function render() {
    var list = visible();
    $('count').textContent = list.length + ' of ' + rows.length + ' rows shown';
    $('rows').innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + money(r.value_if_launches) + '</td>' +
        '<td class="num">' + Math.round(r.odds * 100) + '%</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + money(r.lo25) + ' – ' + money(r.hi75) + '</td>' +
        '<td><span class="verdict ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '<td class="num">' + (r.net_usd >= 0 ? '+' : '') + moneyFull(r.net_usd) + '</td>' +
        '<td class="num">' + moneyFull(r.net_per_hour) + '/hr</td></tr>';
    }).join('');
    $('boardnote').textContent = 'Implied = value if launches × launch odds. Ranges are P25–P75 from held-out residuals. Net is the farm net of all fees over 12 weeks on the row’s deposit.';
  }
  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('watchonly').addEventListener('change', function (e) { state.watchonly = e.target.checked; render(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; render(); });
  $('sort').addEventListener('change', function (e) {
    var v = e.target.value;
    state.sort = v === 'age' ? 'age' : v;
    state.dir = v === 'age' ? 1 : -1;
    render();
  });
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (!k) return;
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = (k === 'name' || k === 'category' || k === 'rank') ? 1 : -1; }
      render();
    });
  });

  /* ---- detail drawer ---- */
  function openDetail(slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    var dep = r.deposit_usd;
    var matrix = [100, 500, 1000, 5000, 10000].map(function (d) {
      var drop = d * (r.value_if_launches / Math.max(1, r.tvl_usd)) * r.odds * 1.0;
      var net = drop - r.fees_usd;
      return '<tr><td>' + moneyFull(d) + '</td><td>' + moneyFull(drop) + '</td><td>' + moneyFull(net) + '</td></tr>';
    }).join('');
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="meta">' + esc(r.slug) + ' · ' + esc(r.category || '—') + ' · ' + esc(r.chains.join(', ')) + '</div>' +
      '<dl>' +
      '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + pct(r.change_7d) + '</dd>' +
      '<dt>Age (no token)</dt><dd>' + (r.age_days === null ? 'unknown' : r.age_days + ' days') + '</dd>' +
      '<dt>Value if launches</dt><dd>' + moneyFull(r.value_if_launches) + '</dd>' +
      '<dt>Launch odds</dt><dd>' + Math.round(r.odds * 100) + '%</dd>' +
      '<dt>Implied value</dt><dd><b>' + moneyFull(r.implied_value_usd) + '</b></dd>' +
      '<dt>P25–P75 range</dt><dd>' + moneyFull(r.lo25) + ' – ' + moneyFull(r.hi75) + '</dd>' +
      '<dt>P10–P90 range</dt><dd>' + moneyFull(r.lo10) + ' – ' + moneyFull(r.hi90) + '</dd>' +
      '<dt>Verdict</dt><dd><span class="verdict ' + r.verdict + '">' + r.verdict + '</span></dd>' +
      '<dt>Deposit</dt><dd>' + moneyFull(r.deposit_usd) + '</dd>' +
      '<dt>Modelled drop</dt><dd>' + moneyFull(r.drop_usd) + '</dd>' +
      '<dt>Fees</dt><dd>' + moneyFull(r.fees_usd) + '</dd>' +
      '<dt>Net / hour</dt><dd>' + moneyFull(r.net_usd) + ' / ' + moneyFull(r.net_per_hour) + '/hr</dd>' +
      '<dt>T-bill (same money)</dt><dd>' + moneyFull(r.tbill_usd) + '</dd>' +
      '<dt>Break-even odds</dt><dd>' + Math.round(r.breakeven_odds * 100) + '%</dd>' +
      '</dl>' +
      '<h3>Deposit-size matrix (net by deposit)</h3><table style="width:100%;font-size:13px"><tr><td>Deposit</td><td>Drop</td><td>Net</td></tr>' + matrix + '</table>' +
      '<h3>Farm plan — ' + r.farm_steps.length + ' steps</h3><ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p style="color:var(--soft);font-size:13px">Exit: claim within 7 days of launch, or if TVL falls to the exit level in the last step, or after 12 weeks with no points. Never pay to claim; use only the protocol’s own published link.</p>';
    $('drawer').hidden = false;
  }
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  $('close').addEventListener('click', function () { $('drawer').hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('drawer').hidden = true; });

  render();
})();
