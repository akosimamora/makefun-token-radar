(function () {
  'use strict';
  var B = window.BOARD;
  var meta = B.meta;
  var templates = B.templates;
  var rows = B.rows;
  var tokenTop = B.token_top;

  function fmtMoney(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(x) {
    if (x === null || x === undefined) return 'n/a';
    return (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function chainList(r) { return r[6].slice(0, 3).join(', ') + (r[6].length > 3 ? ' +' + (r[6].length - 3) : ''); }
  function dateStr(d) {
    return d == null ? null : new Date(d * 86400000).toISOString().slice(0, 10);
  }
  function ageText(d) {
    if (d == null) return 'unknown';
    var asOf = Math.round(new Date(meta.as_of + 'T00:00:00Z') / 86400000);
    return (Math.max(0, asOf - d) / 365.25).toFixed(1) + 'y';
  }
  function farmSteps(r) {
    var ov = B.step_overrides && B.step_overrides[r[0]];
    if (ov) return ov.slice();
    var group = r[9];
    var list = templates[group] || templates['chain'];
    var start = r[10];
    var chain = r[6][0] || 'Ethereum';
    var chain2 = r[6][1] || chain;
    var out = [];
    for (var i = 0; i < 4; i++) {
      out.push(
        list[(start + i) % list.length]
          .replaceAll('{name}', r[1])
          .replaceAll('{chain2}', chain2)
          .replaceAll('{chain}', chain)
          .replaceAll('{tvl}', fmtMoney(r[3]))
          .trim(),
      );
    }
    return out;
  }

  var state = { view: 'pre', q: '', cat: '', sort: 'rank', detail: null };
  var tbody = document.getElementById('rows');
  var countEl = document.getElementById('count');
  var boardTable = document.getElementById('board');
  var tokenView = document.getElementById('tokenview');
  var detailEl = document.getElementById('detail');
  var detailBody = document.getElementById('detailbody');

  function pill(cat) {
    if (!cat) return '—';
    var h = 0;
    for (var i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
    return '<span class="pill" style="background:hsl(' + h + ',45%,20%);color:hsl(' + h + ',75%,76%);border:1px solid hsl(' + h + ',45%,32%)">' + esc(cat) + '</span>';
  }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.cat && r[2] !== state.cat) return false;
      if (q && r[1].toLowerCase().indexOf(q) < 0 && r[0].toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'implied') return b[7] - a[7];
      if (key === 'tvl') return b[3] - a[3];
      if (key === 'change') return (b[4] === null ? -Infinity : b[4]) - (a[4] === null ? -Infinity : a[4]);
      if (key === 'name') return a[1].localeCompare(b[1]);
      return a[8] - b[8];
    });
    return list;
  }

  function render() {
    var banner = document.getElementById('filterbanner');
    var parts = [];
    if (state.view === 'token') parts.push('token already trades');
    if (state.cat) parts.push('category: ' + state.cat);
    if (state.q) parts.push('search: “' + state.q + '”');
    if (parts.length > 0) {
      var n = state.view === 'token' ? tokenTop.length : filtered().length;
      banner.textContent = 'Filtered — ' + parts.join(' · ') + ' — showing ' + n + ' of ' + rows.length;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === state.view);
    });
    var isToken = state.view === 'token';
    boardTable.style.display = isToken ? 'none' : '';
    document.querySelector('.controls').style.display = isToken ? 'none' : '';
    tokenView.hidden = !isToken;
    if (isToken) { renderToken(); return; }
    var list = filtered();
    countEl.textContent = list.length + ' of ' + rows.length + ' shown';
    tbody.innerHTML = list.map(function (r) {
      var chg = r[4];
      var cls = chg === null ? '' : chg >= 0 ? 'up' : 'down';
      var heat = (1 - (r[8] - 1) / (rows.length - 1)) * 0.32 + 0.03;
      return '<tr data-slug="' + esc(r[0]) + '"' + (state.detail === r[0] ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r[8] + '</td>' +
        '<td><b>' + esc(r[1]) + '</b> ' + (r[15] ? '<span class="badge watch">watchlist</span>' : '') + '<br><span style="color:var(--muted);font-size:12px">' + esc(r[0]) + '</span></td>' +
        '<td>' + pill(r[2]) + '</td>' +
        '<td>' + esc(chainList(r)) + '</td>' +
        '<td class="num">' + fmtMoney(r[3]) + '</td>' +
        '<td class="num ' + cls + '">' + fmtPct(chg) + '</td>' +
        '<td class="num" style="background:rgba(232,182,76,' + heat.toFixed(2) + ')"><span class="val">' + fmtMoney(r[7]) + '</span></td></tr>';
    }).join('');
  }

  function renderMix() {
    var counts = {};
    rows.forEach(function (r) { counts[r[2] || 'Uncategorised'] = (counts[r[2] || 'Uncategorised'] || 0) + 1; });
    var entries = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });
    var top = entries.slice(0, 8);
    var other = entries.slice(8).reduce(function (n, e) { return n + e[1]; }, 0);
    if (other > 0) top.push(['Other', other]);
    var hueOf = function (name) {
      var h = 0;
      for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
      return h;
    };
    document.getElementById('mixbar').innerHTML = top.map(function (e) {
      return '<span style="width:' + (e[1] / rows.length * 100).toFixed(1) + '%;background:hsl(' + hueOf(e[0]) + ',55%,45%)" title="' + esc(e[0]) + '"></span>';
    }).join('');
    document.getElementById('mixlegend').innerHTML = top.map(function (e) {
      return '<span><i style="background:hsl(' + hueOf(e[0]) + ',55%,45%)"></i>' + esc(e[0]) + ' · ' + e[1] + '</span>';
    }).join('');
  }

  function renderTop10() {
    var top = rows.slice().sort(function (a, b) { return a[8] - b[8]; }).slice(0, 10);
    var max = top[0][7];
    document.getElementById('topbars').innerHTML = top.map(function (r) {
      var w = Math.max(4, Math.round(r[7] / max * 100));
      return '<div class="bar-row"><span>#' + r[8] + '</span><span class="nm">' + esc(r[1]) + '</span>' +
        '<span class="bar" style="width:' + w + '%"></span><span class="vv">' + fmtMoney(r[7]) + '</span></div>';
    }).join('');
  }

  function renderToken() {
    document.getElementById('tokencount').textContent = meta.token;
    document.getElementById('tokenrows').innerHTML = tokenTop.map(function (t) {
      return '<tr><td><b>' + esc(t[1]) + '</b><br><span style="color:var(--muted);font-size:12px">' + esc(t[0]) + '</span></td>' +
        '<td><span class="badge">$' + esc(t[2] || '—') + '</span></td>' +
        '<td class="num">' + fmtMoney(t[3]) + '</td>' +
        '<td class="num">' + fmtMoney(t[4]) + '</td></tr>';
    }).join('');
  }

  function showDetail(slug) {
    var r = rows.find(function (x) { return x[0] === slug; });
    if (!r) { detailEl.hidden = true; state.detail = null; return; }
    state.detail = slug;
    var steps = farmSteps(r);
    var base = r[3] * 0.3;
    detailBody.innerHTML =
      '<h2>' + esc(r[1]) + '</h2>' +
      '<p style="color:var(--muted);margin:0">Rank #' + r[8] + ' · ' + esc(r[0]) + ' ' + (r[15] ? '<span class="badge watch">watchlist</span>' : '<span class="badge">pre-token</span>') + '</p>' +
      '<dl>' +
      '<dt>Implied value</dt><dd><b style="color:var(--gold)">' + fmtMoney(r[7]) + '</b></dd>' +
      '<dt>TVL</dt><dd>' + fmtMoney(r[3]) + '</dd>' +
      '<dt>7-day change</dt><dd>' + fmtPct(r[4]) + '</dd>' +
      '<dt>Category</dt><dd>' + esc(r[2] || '—') + '</dd>' +
      '<dt>Chains</dt><dd>' + esc(r[6].join(', ')) + '</dd>' +
      '<dt>Tracked since</dt><dd>' + esc(dateStr(r[5]) || 'unknown') + ' (' + ageText(r[5]) + ' with no token)</dd>' +
      '</dl>' +
      '<h3>How the value is built</h3>' +
      '<div class="formula">' + fmtMoney(r[3]) + ' TVL &times; 0.30 = ' + fmtMoney(base) +
      '<br>&times; growth ' + r[11].toFixed(2) + ' &times; age ' + r[12].toFixed(2) +
      ' &times; chains ' + r[13].toFixed(2) + ' &times; plausibility ' + r[14].toFixed(2) +
      (r[16] ? '<br>&times; already-trading ' + r[16] : '') +
      '<br>= <b>' + fmtMoney(r[7]) + '</b></div>' +
      '<h3>Farm plan — concrete steps</h3>' +
      '<ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (r[16]
        ? '<p style="color:var(--muted);font-size:13px">Its token already trades, so there is no launch to farm: the steps above use the live token. It is on the board only because the gate requires every watchlist slug.</p>'
        : '<p style="color:var(--muted);font-size:13px">Records no token in the snapshot (no CoinGecko id, no symbol) — a record, not a promise either way.</p>');
    detailEl.hidden = false;
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.view !== 'pre') p.set('view', state.view);
    if (state.q) p.set('q', state.q);
    if (state.cat) p.set('cat', state.cat);
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.detail) p.set('detail', state.detail);
    var s = p.toString();
    history.replaceState(null, '', s ? 'index.html?' + s : 'index.html');
  }

  document.getElementById('stats').innerHTML =
    '<span><b>' + meta.protocols + '</b> protocols in snapshot</span>' +
    '<span><b>' + meta.pre_token + '</b> record no token</span>' +
    '<span><b>' + meta.token + '</b> already have a token</span>' +
    '<span><b>' + meta.watchlist + '</b> on the watchlist</span>' +
    '<span>As of <b>' + esc(meta.as_of) + '</b></span>';

  var cats = Array.from(new Set(rows.map(function (r) { return r[2]; }).filter(Boolean))).sort();
  document.getElementById('cat').innerHTML =
    '<option value="">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () { state.view = b.getAttribute('data-view'); state.detail = null; detailEl.hidden = true; syncUrl(); render(); });
  });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; syncUrl(); render(); });
  document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; syncUrl(); render(); });
  document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; syncUrl(); render(); });
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var map = { rank: 'rank', name: 'name', category: 'rank', chains: 'rank', tvl: 'tvl', change: 'change', implied: 'implied' };
      state.sort = map[th.getAttribute('data-k')] || 'rank';
      document.getElementById('sort').value = state.sort;
      syncUrl(); render();
    });
  });
  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) { showDetail(tr.getAttribute('data-slug')); syncUrl(); render(); }
  });
  document.getElementById('closedetail').addEventListener('click', function () {
    state.detail = null; detailEl.hidden = true; syncUrl(); render();
  });

  function drawScatter() {
    var cv = document.getElementById('scatter');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, padL = 58, padR = 14, padT = 12, padB = 34;
    ctx.fillStyle = '#16202e';
    ctx.fillRect(0, 0, W, H);
    var xs = rows.map(function (r) { return r[3]; });
    var ys = rows.map(function (r) { return r[7]; });
    var x0 = Math.log10(Math.min.apply(null, xs) * 0.8);
    var x1 = Math.log10(Math.max.apply(null, xs) * 1.25);
    var y0 = Math.log10(Math.min.apply(null, ys) * 0.7);
    var y1 = Math.log10(Math.max.apply(null, ys) * 1.3);
    var X = function (v) { return padL + (Math.log10(v) - x0) / (x1 - x0) * (W - padL - padR); };
    var Y = function (v) { return H - padB - (Math.log10(v) - y0) / (y1 - y0) * (H - padT - padB); };
    ctx.strokeStyle = '#26344a';
    ctx.fillStyle = '#93a5b8';
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    var axisLabel = function (e, unit) {
      return unit === 'B' ? '$' + Math.pow(10, e - 9) + 'B' : '$' + Math.pow(10, e - 6) + 'M';
    };
    for (var e = 6; e <= 10; e++) {
      var gx = X(Math.pow(10, e));
      if (gx < padL || gx > W - padR) continue;
      ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, H - padB); ctx.stroke();
      ctx.fillText(axisLabel(e, e >= 9 ? 'B' : 'M') + ' TVL', gx - 24, H - 12);
    }
    for (var f = 6; f <= 9; f++) {
      var gy = Y(Math.pow(10, f));
      if (gy < padT || gy > H - padB) continue;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillText(axisLabel(f, f >= 9 ? 'B' : 'M'), 6, gy + 4);
    }
    ctx.strokeStyle = '#8a6d2f';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(1e6), Y(3e5)); ctx.lineTo(X(1e10), Y(3e9)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8a6d2f';
    ctx.fillText('30% of TVL', X(2e6) + 6, Y(6e5) - 6);
    rows.forEach(function (r) {
      ctx.beginPath();
      ctx.arc(X(r[3]), Y(r[7]), r[15] ? 5 : 3.5, 0, 6.2832);
      ctx.fillStyle = r[15] ? '#e8b64c' : '#6ea8fe';
      ctx.fill();
    });
    ctx.fillStyle = '#e8eef4';
    ctx.font = 'bold 12px sans-serif';
    [rows[0], rows[4]].forEach(function (r, i) {
      if (!r) return;
      var lx = Math.min(X(r[3]) + 8, W - 190);
      var ly = Y(r[7]) + (i === 0 ? -8 : 16);
      ctx.fillText('#' + r[8] + ' ' + r[1], lx, ly);
    });
  }

  var params = new URLSearchParams(location.search);
  if (params.get('view')) state.view = params.get('view');
  if (params.get('q')) { state.q = params.get('q'); document.getElementById('q').value = state.q; }
  if (params.get('cat')) { state.cat = params.get('cat'); document.getElementById('cat').value = state.cat; }
  if (params.get('sort')) { state.sort = params.get('sort'); document.getElementById('sort').value = state.sort; }
  render();
  renderMix();
  renderTop10();
  drawScatter();
  if (params.get('detail')) showDetail(params.get('detail'));
})();
