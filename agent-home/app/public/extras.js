/* Agent app: charts (SVG) and table export (image, CSV, text). Loaded before app.js; pure helpers + the tooltip. */
'use strict';

// ---------- numbers ----------
// "₹1,234", "12.5%", "3.2L", "1.1 Cr", "-4" → number (Indian units expanded); anything else → NaN.
function parseNum(text) {
  const m = String(text).trim().replace(/\s*\(.*\)$/, '').replace(/^[−–]/, '-').replace(/[,₹$\s]/g, '').match(/^([-+]?\d*\.?\d+)(%|k|K|L|M|Cr|x|R)?$/);
  if (!m) return NaN;
  return Number(m[1]) * ({ k: 1e3, K: 1e3, L: 1e5, M: 1e6, Cr: 1e7 }[m[2]] || 1);
}
function fmtNum(v, unit = '') {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const s = unit === '%' || a < 1e5 ? v.toLocaleString('en-IN', { maximumFractionDigits: a < 10 ? 1 : 0 })
    : a >= 1e7 ? (v / 1e7).toFixed(1) + ' Cr' : (v / 1e5).toFixed(1) + ' L';
  return s + (unit === '%' ? '%' : '');
}
const escX = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- table → data ----------
const TOTAL_ROW = /^(grand\s+)?total\b/i;
const DATEISH = /^(\d{1,2}[\s/-]\w+|\w{3,9}\s\d{1,2}|\d{4}-\d\d(-\d\d)?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(\s?'?\d{2,4})?|(mon|tue|wed|thu|fri|sat|sun)\w*|w(ee)?k\s?\d+|q[1-4].*|day\s?\d+|today|yesterday)$/i;
function tableRows(table) { return [...table.rows].map(r => [...r.cells].map(c => c.innerText.trim())); }
function tableChartSpec(table) {
  const rows = tableRows(table), head = rows[0] || [], body = rows.slice(1).filter(r => r[0] && !TOTAL_ROW.test(r[0]));
  const numCols = head.map((_, c) => c).filter(c => c > 0 && table.rows[1]?.cells[c]?.classList.contains('num'));
  if (!numCols.length || body.length < 2) return null;
  // One axis only: chart the columns that share the first numeric column's unit (% vs plain numbers).
  const unitOf = c => body.some(r => /%$/.test(r[c])) ? '%' : '';
  const unit = unitOf(numCols[0]);
  const cols = numCols.filter(c => unitOf(c) === unit).slice(0, 4);
  const labels = body.map(r => r[0]);
  return {
    type: labels.length >= 4 && labels.every(l => DATEISH.test(l)) ? 'line' : 'bar',
    unit, labels, series: cols.map(c => ({ name: head[c] || `Column ${c + 1}`, data: body.map(r => parseNum(r[c])) })),
    note: numCols.length > cols.length ? 'Showing the columns that share one scale.' : '',
  };
}

// ---------- charts ----------
// Categorical slots come from CSS (--s1…--s4, light/dark steps of the validated reference palette).
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
function niceMax(v) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function renderChart(spec) {
  const series = (spec.series || []).slice(0, 4).map(s => ({ name: String(s.name ?? ''), data: (s.data || []).map(Number) }));
  const labels = (spec.labels || []).map(String);
  if (!series.length || !labels.length) return '';
  const unit = spec.unit || '', many = series.length > 1;
  const legend = many ? `<div class="viz-legend">${series.map((s, j) => `<span><i style="background:${SERIES[j]}"></i>${escX(s.name)}</span>`).join('')}</div>` : '';
  const title = spec.title ? `<div class="viz-title">${escX(spec.title)}</div>` : '';
  const note = spec.note ? `<div class="viz-note">${escX(spec.note)}</div>` : '';
  const svg = spec.type === 'line' ? lineChart(labels, series, unit) : barChart(labels, series, unit);
  return `<div class="viz">${title}${legend}${svg}${note}</div>`;
}
function tipFor(label, series, i, unit) {
  return escX(`<b>${escX(label)}</b>` + series.map((s, j) => `<span><i style="background:${SERIES[j]}"></i>${escX(s.name)} ${escX(fmtNum(s.data[i], unit))}</span>`).join(''));
}
function barChart(labels, series, unit) {   // horizontal bars: long names fit on a phone
  labels = labels.slice(0, 24);
  const W = 340, k = series.length, barH = k > 1 ? 10 : 14, gap = 2, groupH = k * barH + (k - 1) * gap, rowGap = 10;
  const labelW = 108, valueW = k === 1 ? 46 : 8, plotX = labelW, plotW = W - labelW - valueW;
  const all = series.flatMap(s => s.data.slice(0, labels.length)).filter(Number.isFinite);
  const min = Math.min(0, ...all), max = Math.max(0, ...all), span = max - min || 1;
  const x = v => plotX + (v - min) / span * plotW, zero = x(0);
  const H = 6 + labels.length * (groupH + rowGap);
  let out = '';
  labels.forEach((l, i) => {
    const y0 = 4 + i * (groupH + rowGap), short = l.length > 16 ? l.slice(0, 15) + '…' : l;
    out += `<g class="viz-hit" data-tip="${tipFor(l, series, i, unit)}"><rect x="0" y="${y0 - rowGap / 2}" width="${W}" height="${groupH + rowGap}" fill="transparent"/>`;
    out += `<text x="${labelW - 8}" y="${y0 + groupH / 2 + 4}" text-anchor="end" class="viz-label">${escX(short)}</text>`;
    series.forEach((s, j) => {
      const v = s.data[i]; if (!Number.isFinite(v)) return;
      const y = y0 + j * (barH + gap), xa = Math.min(x(v), zero), w = Math.max(Math.abs(x(v) - zero), v ? 2 : 0);
      out += `<rect x="${xa}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${SERIES[j]}"/>`;
      if (k === 1) out += `<text x="${v < 0 ? xa - 4 : xa + w + 4}" y="${y + barH / 2 + 4}" text-anchor="${v < 0 ? 'end' : 'start'}" class="viz-val">${escX(fmtNum(v, unit))}</text>`;
    });
    out += '</g>';
  });
  if (min < 0) out += `<line x1="${zero}" x2="${zero}" y1="0" y2="${H}" class="viz-axis"/>`;
  return `<svg class="viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${out}</svg>`;
}
function lineChart(labels, series, unit) {
  const W = 340, H = 190, L = 40, R = 12, T = 10, B = 24, n = labels.length, pw = W - L - R, ph = H - T - B;
  const all = series.flatMap(s => s.data).filter(Number.isFinite);
  const lo = Math.min(0, ...all), hi = niceMax(Math.max(...all, 0)) || 1, span = hi - lo || 1;
  const x = i => L + (n === 1 ? pw / 2 : i * pw / (n - 1)), y = v => T + ph - (v - lo) / span * ph;
  let out = '';
  for (let t = 0; t <= 4; t++) {   // recessive grid + y labels
    const v = lo + span * t / 4, yy = y(v);
    out += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="viz-grid"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end" class="viz-tick">${escX(fmtNum(v, unit))}</text>`;
  }
  const step = Math.max(1, Math.ceil(n / 5));
  labels.forEach((l, i) => {
    if (i % step && i !== n - 1) return;
    out += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="viz-tick">${escX(l.length > 9 ? l.slice(0, 8) + '…' : l)}</text>`;
  });
  series.forEach((s, j) => {
    const pts = s.data.map((v, i) => Number.isFinite(v) ? [x(i), y(v)] : null);
    const d = pts.reduce((acc, p, i) => p ? acc + (acc && pts[i - 1] ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) : acc, '');
    out += `<path d="${d}" fill="none" stroke="${SERIES[j]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n <= 16) pts.forEach(p => { if (p) out += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${SERIES[j]}" class="viz-dot"/>`; });
  });
  labels.forEach((l, i) => {   // hover columns, wider than the marks
    const w = n === 1 ? pw : pw / (n - 1);
    out += `<rect class="viz-hit" x="${x(i) - w / 2}" y="${T}" width="${w}" height="${ph}" fill="transparent" data-x="${x(i)}" data-tip="${tipFor(l, series, i, unit)}"/>`;
  });
  return `<svg class="viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">${out}<line class="viz-cross" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/></svg>`;
}
// Tooltip: hover with a mouse, tap on a phone.
(() => {
  let tip = null;
  const show = (el, cx, cy) => {
    tip ||= Object.assign(document.createElement('div'), { className: 'viz-tip' });
    if (!tip.isConnected) document.body.appendChild(tip);
    tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(8, cx - r.width / 2), innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.max(8, cy - r.height - 14) + 'px';
    const svg = el.closest('svg'), cross = svg?.querySelector('.viz-cross');
    svg?.querySelectorAll('.viz-hit.on').forEach(x => x.classList.remove('on')); el.classList.add('on');
    if (cross && el.dataset.x) { cross.setAttribute('x1', el.dataset.x); cross.setAttribute('x2', el.dataset.x); cross.setAttribute('visibility', 'visible'); }
  };
  const hide = () => {
    if (tip) tip.hidden = true;
    document.querySelectorAll('.viz-hit.on').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.viz-cross').forEach(c => c.setAttribute('visibility', 'hidden'));
  };
  document.addEventListener('pointermove', e => {
    const h = e.pointerType === 'mouse' && e.target.closest?.('.viz-hit');
    if (h) show(h, e.clientX, e.clientY); else if (e.pointerType === 'mouse') hide();
  }, { passive: true });
  document.addEventListener('click', e => { const h = e.target.closest?.('.viz-hit'); if (h) show(h, e.clientX, e.clientY); else hide(); });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
})();

// ---------- table → image / CSV / text ----------
function tableTitle(wrap) {   // the heading or bold line just above the table, if any
  for (let el = wrap.previousElementSibling; el; el = el.previousElementSibling) {
    if (/^H[1-4]$/.test(el.tagName)) return el.innerText.trim();
    if (el.tagName === 'P') { const b = el.querySelector('strong'); return b && b.innerText.trim().length > el.innerText.trim().length - 3 ? b.innerText.trim().replace(/:$/, '') : ''; }
    if (!el.classList.contains('tbl-tools') && !el.classList.contains('viz')) return '';
  }
  return '';
}
function tableImage(wrap) {   // draws the table on a canvas (theme colours), resolves to a PNG blob
  const table = wrap.querySelector('table'), cs = getComputedStyle(document.documentElement);
  const col = n => cs.getPropertyValue(n).trim();
  const C = { bg: col('--surface'), head: col('--surface-2'), text: col('--text'), muted: col('--muted'), line: getComputedStyle(table.querySelector('td, th')).borderBottomColor };
  const fam = getComputedStyle(document.body).fontFamily, S = 2, M = 18, PX = 12, LH = 20, PY = 9;
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  const font = (b, sz = 14) => `${b ? 600 : 400} ${sz}px ${fam}`;
  const rows = [...table.rows].map((r, ri) => [...r.cells].map(c => ({ t: c.innerText.trim(), b: ri === 0 || !!c.querySelector('strong, b'), num: c.classList.contains('num'), long: c.classList.contains('long') })));
  const ncol = Math.max(...rows.map(r => r.length));
  const wrapText = (t, w, b) => {   // greedy word wrap
    g.font = font(b); const out = []; let line = '';
    for (const word of t.split(/\s+/)) { const tryL = line ? line + ' ' + word : word; if (g.measureText(tryL).width > w && line) { out.push(line); line = word; } else line = tryL; }
    return out.concat(line ? [line] : ['']);
  };
  const widths = [...Array(ncol)].map((_, c) => {
    let w = 30;
    for (const r of rows) if (r[c]) { g.font = font(r[c].b); w = Math.max(w, g.measureText(r[c].t).width); }
    return Math.min(w, rows.some(r => r[c]?.long) ? 300 : 420) + PX * 2;
  });
  const lines = rows.map(r => r.map((cell, c) => wrapText(cell.t, widths[c] - PX * 2, cell.b)));
  const heights = lines.map(r => Math.max(...r.map(l => l.length)) * LH + PY * 2);
  const title = tableTitle(wrap), titleH = title ? 34 : 0, footH = 26;
  const W = widths.reduce((a, b) => a + b, 0) + M * 2, H = heights.reduce((a, b) => a + b, 0) + M * 2 + titleH + footH;
  cv.width = W * S; cv.height = H * S; g.scale(S, S);
  g.fillStyle = col('--bg'); g.fillRect(0, 0, W, H);
  let y = M;
  if (title) { g.font = font(true, 16); g.fillStyle = C.text; g.textBaseline = 'top'; g.fillText(title, M, y); y += titleH; }
  const tw = W - M * 2, th = heights.reduce((a, b) => a + b, 0);
  g.save(); g.beginPath(); g.roundRect(M, y, tw, th, 12); g.fillStyle = C.bg; g.fill(); g.clip();
  g.fillStyle = C.head; g.fillRect(M, y, tw, heights[0]);
  rows.forEach((r, ri) => {
    let x = M;
    r.forEach((cell, c) => {
      g.font = font(cell.b, ri === 0 ? 13 : 14); g.fillStyle = ri === 0 ? C.muted : C.text; g.textBaseline = 'middle';
      const ls = lines[ri][c], top = y + (heights[ri] - ls.length * LH) / 2;
      ls.forEach((l, k) => {
        const lw = g.measureText(l).width;
        g.fillText(l, cell.num ? x + widths[c] - PX - lw : x + PX, top + k * LH + LH / 2);
      });
      x += widths[c];
    });
    y += heights[ri];
    if (ri < rows.length - 1) { g.fillStyle = C.line; g.fillRect(M, y - 0.5, tw, 1); }
  });
  g.restore();
  g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.roundRect(M + 0.5, M + titleH + 0.5, tw - 1, th - 1, 12); g.stroke();
  g.font = font(false, 11); g.fillStyle = C.muted; g.textBaseline = 'alphabetic';
  g.fillText((document.body.dataset.agent || 'Agent') + ' · ' + new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), M, H - M + 4);
  return new Promise(res => cv.toBlob(res, 'image/png'));
}
function tableCSV(table) {
  return tableRows(table).map(r => r.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
}
const tableTSV = table => tableRows(table).map(r => r.map(v => v.replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
async function saveFile(file) {   // phone: share sheet (Save to Files, WhatsApp…); laptop: download
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; } }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
