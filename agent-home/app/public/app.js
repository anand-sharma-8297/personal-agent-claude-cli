/* the agent app — chat client. Talks to app/server.mjs (same origin). */
'use strict';
const T = window.TOKEN;
const AGENT = document.body?.dataset.agent || 'Agent', OWNER = (document.body?.dataset.owner || '').split(' ')[0];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const withT = url => url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(T);
const isTouch = matchMedia('(pointer: coarse)').matches;
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const cid = Math.random().toString(36).slice(2, 10);

async function api(path, body, opts = {}) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Token': T, ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ---------- state ----------
const S = {
  msgs: new Map(), order: [], els: new Map(), more: false,
  live: { state: 'offline', task: null, usage: null, bridge: false, browsers: {} },
  sse: false, replyTo: null, uploads: [], unread: 0, workOpen: false, vapid: '', atBottom: true,
  suggest: ['What can you do for me?'],   // empty-chat buttons, from /api/suggestions
  session: '', current: '', follow: true, pendingResume: '',   // shown session, the agent's live session, showing the live one?
};

// ---------- time helpers ----------
const two = n => String(n).padStart(2, '0');
const clock = ts => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const dur = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${two(s % 60)}`; };
function dayLabel(ts) {
  const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
}
const size = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

// ---------- markdown ----------
const NUM_RE = /^[-+−–]?\s?[₹$]?\s?\d[\d,]*(\.\d+)?\s?(%|[KkLM]|Cr|x|R)?$/;
function cellKind(v) {   // 'num' | 'dash' | 'note' (number or dash + "(…)") | 'text'
  if (NUM_RE.test(v)) return 'num';
  if (/^[-–—]$/.test(v)) return 'dash';
  const m = v.match(/^(\S+)\s+\(.*\)$/);
  return m && (NUM_RE.test(m[1]) || /^[-–—]$/.test(m[1])) ? 'note' : 'text';
}
const TABLE_TOOLS = [
  ['copy', 'Copy', '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'],
  ['image', 'Image', '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8.5"/>'],
  ['csv', 'Excel', '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M9 13l4 4M13 13l-4 4"/>'],
  ['chart', 'Chart', '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>'],
];
// Wide tables scroll sideways; a fade on the right shows there is more.
function tableEdge(w) {
  w.classList.toggle('more', w.scrollWidth - w.clientWidth - w.scrollLeft > 4);
  w.classList.toggle('moved', w.scrollLeft > 2);
}
document.addEventListener('scroll', e => { if (e.target.classList?.contains('tbl')) tableEdge(e.target); }, { capture: true, passive: true });
const tableEdges = () => requestAnimationFrame(() => document.querySelectorAll('.md .tbl').forEach(tableEdge));
window.addEventListener('resize', tableEdges);
function md(text) {
  if (!window.marked || !window.DOMPurify) return esc(text).replace(/\n/g, '<br>');
  const html = DOMPurify.sanitize(marked.parse(String(text || ''), { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
  const box = document.createElement('div'); box.innerHTML = html;
  box.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // ```chart {json} blocks from the agent become SVG charts (see renderChart in extras.js).
  box.querySelectorAll('pre code.language-chart').forEach(c => {
    let html = ''; try { html = renderChart(JSON.parse(c.textContent)); } catch {}
    if (html) c.parentElement.outerHTML = html;
  });
  box.querySelectorAll('table').forEach(t => {
    const w = document.createElement('div'); w.className = 'tbl'; t.replaceWith(w); w.appendChild(t);
    // Column kinds: numbers (right-aligned, one line; "17.57 (day end)" style notes may wrap), short text (one line),
    // long text (wraps, gets a minimum width so it doesn't become a tall narrow strip).
    const rows = [...t.rows];
    for (let c = 0; c < (rows[0]?.cells.length || 0); c++) {
      const cells = rows.map(r => r.cells[c]).filter(Boolean), body = cells.slice(1).map(x => x.textContent.trim()).filter(Boolean);
      const kinds = body.map(cellKind), longest = Math.max(0, ...body.map(v => v.length));
      const num = kinds.length && kinds.every(k => k !== 'text') && kinds.some(k => k === 'num' || k === 'note');
      cells.forEach((x, i) => {
        x.classList.add(num ? 'num' : longest > 60 ? 'long' : longest > 16 ? 'mid' : 'short');
        if (num && i && cellKind(x.textContent.trim()) === 'note') x.classList.add('note');
      });
    }
    const chartable = rows.length > 2 && [...(rows[1]?.cells || [])].some((c, i) => i > 0 && c.classList.contains('num'));
    w.insertAdjacentHTML('afterend', `<div class="tbl-tools">${TABLE_TOOLS.filter(([k]) => k !== 'chart' || chartable).map(([k, label, icon]) =>
      `<button data-tt="${k}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24">${icon}</svg><span>${label}</span></button>`).join('')}</div>`);
  });
  box.querySelectorAll('pre').forEach(p => { const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy'; b.dataset.copy = '1'; p.appendChild(b); });
  return box.innerHTML;
}

// ---------- step icons (the watcher labels steps with emoji; the app shows line icons instead) ----------
const STEP_ICONS = {
  '🔧': '<path d="M4 17l6-5-6-5M12 19h8"/>',
  '🌐': '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
  '🧩': '<path d="M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v5"/>',
  '💬': '<path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/>',
  '📄': '<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8zM14 3.5V8h4.5"/>',
  '✏️': '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  '🔎': '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  '🤖': '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M6.5 9v3a5 5 0 0 0 5 5H15"/>',
  '📎': '<path d="M20 11.5l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8"/>',
};
const DOT_ICON = '<circle cx="12" cy="12" r="2.5"/>';
function stepParts(label) {
  const s = String(label || '');
  for (const k of Object.keys(STEP_ICONS)) if (s.startsWith(k)) return { icon: STEP_ICONS[k], text: s.slice(k.length).trim() };
  return { icon: DOT_ICON, text: s.replace(/^[•\s]+/, '') };
}
const stepHTML = label => { const p = stepParts(label); return `<svg class="si" viewBox="0 0 24 24">${p.icon}</svg><span>${esc(p.text)}</span>`; };

// ---------- rendering ----------
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

function msgEl(m) {
  const el = document.createElement('div');
  el.className = `m ${m.from}`; el.dataset.id = m.id;
  const files = m.files || [];
  const pics = files.filter(f => f.kind === 'image' || f.kind === 'video');
  const voices = files.filter(f => f.kind === 'voice' || (f.kind === 'audio' && m.from === 'me'));
  const docs = files.filter(f => !pics.includes(f) && !voices.includes(f));
  let inner = '';
  if (m.reply_to && S.msgs.get(m.reply_to)) inner += `<div class="quote">${esc(plain(S.msgs.get(m.reply_to)))}</div>`;
  if (pics.length) inner += `<div class="media">${pics.map(f => f.kind === 'image'
    ? `<img src="${esc(withT(f.url))}" alt="${esc(f.name)}" loading="lazy" data-view="${esc(withT(f.url))}">`
    : `<video src="${esc(withT(f.url))}" controls playsinline preload="metadata"></video>`).join('')}</div>`;
  for (const f of voices) inner += `<div class="voice" data-src="${esc(withT(f.url))}"><button class="play" aria-label="Play">${ICON_PLAY}</button><div class="track"><i></i></div><span class="dur">0:00</span></div>`;
  if (m.transcribing) inner += '<div class="transcript pending">Transcribing…</div>';
  else if (m.transcript) inner += `<div class="transcript">“${esc(m.transcript)}”</div>`;
  for (const f of docs) {
    const ext = (f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
    inner += `<a class="filecard" href="${esc(withT(f.url))}" target="_blank" rel="noopener" download="${esc(f.name)}"><span class="fi">${esc(ext)}</span><span><div class="fn">${esc(f.name)}</div><div class="fs">${size(f.size || 0)}</div></span></a>`;
  }
  if (m.text) inner += `<div class="md">${md(m.text)}</div>`;
  const reacts = Object.keys(m.reactions || {});
  if (reacts.length) { inner += `<span class="react">${esc(reacts.join(''))}</span>`; el.classList.add('has-react'); }
  let html = `<div class="bubble">${inner}</div>`;
  if (m.buttons?.length) {
    html += `<div class="chips${m.chosen ? ' done' : ''}">${m.buttons.map(b =>
      `<button class="chip${m.chosen === b ? ' on' : ''}" data-chip="${esc(b)}"${m.chosen ? ' disabled' : ''}>${esc(b)}</button>`).join('')}</div>`;
  }
  let tick = '';
  if (m.readonly) { el.classList.add('ro'); tick = `<span class="via">via ${m.via === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>`; }
  else if (m.from === 'me') tick = m.transcribing ? '' : m.status === 'read' ? '<span class="tick read">✓✓</span>' : m.status === 'delivered' ? '<span class="tick">✓</span>' : '<span class="tick q">◷</span>';
  html += `<div class="meta">${clock(m.ts)}${m.edited ? ' · edited' : ''}${tick}</div>`;
  if (m.from !== 'system' && (m.text || m.transcript)) html += `<div class="acts"><button data-act="reply">Reply</button><button data-act="copy">Copy</button>${m.from === 'agent' && !m.readonly ? '<button data-act="retry">Ask again with Opus</button>' : ''}</div>`;
  if (m.from === 'agent' && !m.readonly) html += '<div class="retry-row"><button data-act="retry"><svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5"/></svg>Ask again with Opus</button></div>';
  el.innerHTML = html;
  if (m.from !== 'me' && /<(table|pre)/.test(inner)) el.classList.add('wide');
  return el;
}
const plain = m => (m.text || (m.transcript ? `Voice: ${m.transcript}` : (m.files || []).map(f => f.name).join(', '))).replace(/[*_`#>|]/g, '').slice(0, 140);

function layout() {
  const box = $('msgs'), frag = document.createDocumentFragment();
  let prev = null, lastDay = '';
  if (!S.order.length) {
    box.innerHTML = `<div class="empty"><img class="hero" src="/icons/hero.jpg" alt=""><h2>Hi${OWNER ? ', ' + esc(OWNER) : ''}</h2><p>Ask me anything: research, websites, files, the browser…</p>
      <div class="chips" style="justify-content:center;margin:14px auto 0">${S.suggest
        .map(s => `<button class="chip" data-chip="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    return;
  }
  S.order.forEach((id, i) => {
    const m = S.msgs.get(id), next = S.msgs.get(S.order[i + 1]);
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { const d = document.createElement('div'); d.className = 'day'; d.innerHTML = `<span>${dayLabel(m.ts)}</span>`; frag.appendChild(d); lastDay = day; prev = null; }
    let el = S.els.get(id);
    if (!el) { el = msgEl(m); S.els.set(id, el); }
    const first = !prev || prev.from !== m.from || m.ts - prev.ts > 300_000;
    const last = !next || next.from !== m.from || next.ts - m.ts > 300_000 || new Date(next.ts).toDateString() !== day;
    el.classList.toggle('first', first); el.classList.toggle('last', last);
    el.querySelector('.meta').hidden = !last && m.from !== 'me';
    frag.appendChild(el); prev = m;
  });
  box.replaceChildren(frag);
  tableEdges();
}

function upsert(m, { live = false } = {}) {
  const had = S.msgs.has(m.id);
  S.msgs.set(m.id, m); S.els.delete(m.id);
  if (!had) {
    S.order.push(m.id);
    S.order.sort((a, b) => S.msgs.get(a).ts - S.msgs.get(b).ts);
  }
  const stick = nearBottom() || S.atBottom;
  layout();
  if (live && !had) {
    if (stick || m.from === 'me') scrollBottom(true);
    else { S.unread++; showUnread(); }
  } else if (stick) scrollBottom();
}

// ---------- scrolling ----------
const thread = $('thread');
const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
function scrollBottom(smooth) { requestAnimationFrame(() => thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); }
function showUnread() { $('toBottom').hidden = nearBottom() && !S.unread; $('unread').hidden = !S.unread; $('unread').textContent = S.unread; }
thread.addEventListener('scroll', () => {
  if (nearBottom()) S.unread = 0;
  $('toBottom').hidden = nearBottom();
  $('unread').hidden = !S.unread; $('unread').textContent = S.unread;
}, { passive: true });
$('toBottom').onclick = () => { S.unread = 0; S.atBottom = true; scrollBottom(true); };

// ---------- history ----------
const sessQ = () => S.session ? '&session=' + encodeURIComponent(S.session) : '';
async function loadThread(id) {
  const r = await api('/api/messages?limit=80' + (id ? '&session=' + encodeURIComponent(id) : ''));
  S.msgs = new Map(); S.order = []; S.els = new Map(); S.unread = 0;
  S.session = r.session; S.current = r.current; S.follow = r.session === r.current;
  for (const m of r.messages) { S.msgs.set(m.id, m); S.order.push(m.id); }
  S.more = r.more; $('older').hidden = !S.more;
  layout(); updatePast(); renderStatus(); renderWork();
  S.atBottom = true; scrollBottom(); setTimeout(scrollBottom, 300);
  if (sessData) renderSessions();
}
async function loadLatest() {
  const r = await api('/api/messages?limit=80' + sessQ());
  if (!S.session || (S.follow && r.current && r.current !== S.session)) return loadThread(S.follow ? r.current : S.session);
  S.current = r.current;
  const fresh = !S.order.length;
  for (const m of r.messages) { S.msgs.set(m.id, m); S.els.delete(m.id); if (!S.order.includes(m.id)) S.order.push(m.id); }
  S.order.sort((a, b) => S.msgs.get(a).ts - S.msgs.get(b).ts);
  if (fresh) S.more = r.more;
  $('older').hidden = !S.more;
  layout(); if (fresh) { scrollBottom(); setTimeout(scrollBottom, 300); } else if (nearBottom()) scrollBottom();
}
$('olderBtn').onclick = async () => {
  const first = S.order[0]; if (!first) return;
  const h = thread.scrollHeight;
  const r = await api(`/api/messages?limit=60&before=${encodeURIComponent(first)}` + sessQ());
  for (const m of r.messages) { S.msgs.set(m.id, m); if (!S.order.includes(m.id)) S.order.push(m.id); }
  S.order.sort((a, b) => S.msgs.get(a).ts - S.msgs.get(b).ts);
  S.more = r.more; $('older').hidden = !S.more;
  layout(); thread.scrollTop = thread.scrollHeight - h;
};

// ---------- live state ----------
// True while the agent is busy AND hasn't answered since its last real step. After the answer arrives it is only
// wrapping up (notes, journal), so the app treats it as done; a new real step after that shows the card again.
function busy() {
  const L = S.live, t = L.task;
  if (L.state !== 'working' || !S.sse) return false;
  if (!t) return true;
  const lastReply = S.order.map(id => S.msgs.get(id)).filter(m => m.from === 'agent').reduce((a, m) => Math.max(a, m.ts / 1000), 0);
  if (lastReply < t.start) return true;                       // no answer yet for this task
  // Answered. Steps right after an answer are usually wrap-up (journal, notes): only show the card again if
  // real work is still going on more than 8 s after the answer.
  const after = (t.steps || []).some(x => !x.s.startsWith('💬') && x.t > lastReply);
  return after && Date.now() / 1000 - lastReply > 8;
}
const onOpus = () => /opus/i.test(S.live.usage?.model || '');
function setLive(st) {
  const was = S.live.state;
  document.body.classList.toggle('on-opus', /opus/i.test(st.usage?.model || ''));   // hides "Ask again with Opus"
  if (was === 'working' && st.state === 'idle' && S.follow && S.session) setTimeout(() => loadLatest().catch(() => {}), 800);
  if (was === 'working' && st.state === 'idle' && $('side').classList.contains('docked')) setTimeout(loadSessions, 1500);
  S.live = st; renderStatus(); renderWork(); if (!$('sheet').hidden) renderSheet(); renderPanel();
}
function renderStatus() {
  const L = S.live, t = L.task;
  let cls = 'idle', text;
  if (!S.sse) { cls = 'offline'; text = 'Connecting…'; }
  else if (L.state === 'offline' || !L.bridge) { cls = 'restarting'; text = 'Offline · messages will wait'; }
  else if (busy()) { cls = 'working'; text = t ? `Working · ${dur(Date.now() / 1000 - t.start)}` : 'Working…'; }
  else text = `Online${L.usage?.model ? ' · ' + L.usage.model : ''}`;
  $('status').className = `status s-${cls}`; $('statusText').textContent = text;
  document.body.classList.toggle('working', cls === 'working');
  const banner = !S.sse ? 'Reconnecting…' : (!L.bridge || L.state === 'offline') ? `${AGENT} is restarting. Your messages will be delivered when it’s back.` : '';
  $('banner').hidden = !banner; $('banner').textContent = banner;
  document.body.classList.toggle('has-banner', !!banner);
  const working = busy();
  $('stopBtn').hidden = !(working && !hasDraft());
  $('micBtn').hidden = hasDraft() || working;
  $('sendBtn').hidden = !hasDraft();
}
function renderWork() {
  const t = S.live.task, on = busy() && !!t;
  const card = $('work'), wasHidden = card.hidden, stick = nearBottom() || S.atBottom;
  card.hidden = !on;
  if (!on) return;
  const steps = t.steps || [];
  const ch = t.channel && t.channel !== 'app' ? ` (${t.channel[0].toUpperCase() + t.channel.slice(1)})` : '';
  $('workLabel').textContent = 'Working' + ch;
  $('workCount').textContent = `${t.count || steps.length} step${(t.count || steps.length) === 1 ? '' : 's'}`;
  $('workNow').textContent = steps.length ? stepParts(steps.at(-1).s).text : 'Thinking…';
  $('workSteps').innerHTML = steps.map(x => `<li><span class="t">+${dur(x.t - t.start)}</span>${stepHTML(x.s)}</li>`).join('');
  card.classList.toggle('open', S.workOpen);
  if (S.workOpen) $('workSteps').scrollTop = 1e6;
  tick();
  if (stick) { S.atBottom = true; scrollBottom(); }
}
let lastBusy = false;
function tick() {
  const t = S.live.task;
  if (busy() !== lastBusy) { lastBusy = busy(); renderStatus(); renderWork(); }
  if (busy() && t) {
    $('workTime').textContent = dur(Date.now() / 1000 - t.start);
    if (S.sse && S.live.bridge) $('statusText').textContent = `Working · ${dur(Date.now() / 1000 - t.start)}`;
  }
}
setInterval(tick, 1000);
$('workToggle').onclick = () => { S.workOpen = !S.workOpen; renderWork(); };

// ---------- events (SSE) ----------
let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource(withT(`/api/events?cid=${cid}&visible=${document.hidden ? 0 : 1}`));
  es.onopen = () => { S.sse = true; renderStatus(); loadLatest().catch(() => {}); };
  es.onerror = () => { S.sse = false; renderStatus(); };
  es.addEventListener('msg', e => {
    const m = JSON.parse(e.data);
    if (m.session && S.session && m.session !== S.session) return;   // belongs to another session
    upsert(m, { live: true }); renderStatus(); renderWork();
  });
  es.addEventListener('session', e => {
    const id = JSON.parse(e.data).current; if (!id || id === S.current) return;
    const wasFollowing = S.follow || S.pendingResume === id;
    S.current = id; S.pendingResume = '';
    if (wasFollowing) { loadThread(id); toast(`${AGENT} is now in this session`); }
    if (!$('side').hidden) loadSessions();
  });
  es.addEventListener('state', e => setLive(JSON.parse(e.data)));
  es.addEventListener('prefs', e => { applyPrefs(JSON.parse(e.data)); if (!$('custom').hidden) renderCustom(); });
  es.addEventListener('bridge', e => { S.live.bridge = JSON.parse(e.data).connected; renderStatus(); });
}
document.addEventListener('visibilitychange', () => {
  api('/api/presence', { cid, visible: !document.hidden }).catch(() => {});
  if (!document.hidden && (!es || es.readyState === 2)) connect();
});

// ---------- composer ----------
const input = $('input');
const hasDraft = () => input.value.trim().length > 0 || S.uploads.length > 0;
function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; }
input.addEventListener('input', () => { grow(); renderStatus(); palette(); });
input.addEventListener('keydown', e => {
  if (!$('palette').hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) return paletteKey(e);
  if (e.key === 'Enter' && !e.shiftKey && !isTouch) { e.preventDefault(); send(); }
});
$('sendBtn').onclick = () => send();
$('stopBtn').onclick = async () => {
  if (!confirm('Stop the current task?')) return;
  try { await api('/api/stop', {}); toast('Stopping…'); } catch (e) { toast('Could not stop: ' + e.message); }
};

const LOCAL = { '/info': 'info', '/status': 'info', '/usage': 'usage', '/sessions': 'sessions', '/model': 'model',
  '/new': 'new', '/compact': 'compact', '/restart': 'restart', '/pending': 'pending' };
// Commands the app runs itself (fast), including the "/model opus" and "/resume 2 · …" buttons.
function localCmd(text) {
  const t = text.trim().toLowerCase(), m = t.match(/^\/(model|resume)\s+(\w+)/);
  return LOCAL[t] || (m ? `${m[1]} ${m[2]}` : null);
}
async function send(text = input.value, extra = {}) {
  text = text.trim();
  const ups = S.uploads.slice();
  if (!text && !ups.length) return;
  if (!ups.length && localCmd(text)) { clearDraft(); return command(localCmd(text)); }
  try {
    const ids = await Promise.all(ups.map(u => u.done));
    await api('/api/send', { text, files: ids, reply_to: S.replyTo || undefined, ...extra });
    clearDraft(); setReply(null);
  } catch (e) { toast('Not sent: ' + e.message); }
}
function clearDraft() { input.value = ''; grow(); S.uploads = []; renderTray(); renderStatus(); $('palette').hidden = true; }
async function command(cmd, chose) { try { await api('/api/command', { cmd, chose }); } catch (e) { toast(e.message); } }

// slash palette
const CMDS = [
  ['/info', `Status of ${AGENT} and the laptop`], ['/usage', 'Claude limits: 5-hour and weekly'], ['/sessions', 'Go back to an earlier session'],
  ['/model', 'Switch model'], ['/pending', 'Items waiting on you'], ['/new', 'Fresh session (memory kept)'], ['/compact', 'Summarise this session'],
  ['/restart', `Restart browsers and ${AGENT}`], ['/stop', 'Cancel the current task'],
];
let palSel = 0;
function palette() {
  const v = input.value, p = $('palette');
  if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) { p.hidden = true; return; }
  const list = CMDS.filter(([c]) => c.startsWith(v.toLowerCase()));
  if (!list.length) { p.hidden = true; return; }
  palSel = Math.min(palSel, list.length - 1);
  p.innerHTML = list.map(([c, d], i) => `<button data-pal="${c}" class="${i === palSel ? 'sel' : ''}"><b>${c}</b><span>${esc(d)}</span></button>`).join('');
  p.hidden = false;
}
function paletteKey(e) {
  const items = [...$('palette').querySelectorAll('button')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; palette(); return; }
  e.preventDefault(); items[palSel]?.click();
}
$('palette').addEventListener('click', e => { const b = e.target.closest('[data-pal]'); if (b) { input.value = b.dataset.pal; send(); } });

// attachments
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => { for (const f of e.target.files) addUpload(f); e.target.value = ''; };
function addUpload(file, kind) {
  const u = { name: file.name, kind: kind || (file.type.startsWith('image/') ? 'image' : 'file'), preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '', up: true };
  u.done = fetch('/api/upload', { method: 'POST', headers: { 'X-Token': T, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream', ...(kind ? { 'X-Kind': kind } : {}) }, body: file })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('upload failed'))).then(j => { u.up = false; renderTray(); return j.id; })
    .catch(err => { S.uploads = S.uploads.filter(x => x !== u); renderTray(); toast(`${file.name}: ${err.message}`); throw err; });
  S.uploads.push(u); renderTray(); renderStatus();
  return u;
}
function renderTray() {
  const t = $('tray'); t.hidden = !S.uploads.length;
  t.innerHTML = S.uploads.map((u, i) => `<div class="att${u.up ? ' up' : ''}">${u.preview ? `<img src="${u.preview}" alt="">` : esc(u.name)}<button class="x" data-rm="${i}">×</button></div>`).join('');
}
$('tray').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { S.uploads.splice(Number(b.dataset.rm), 1); renderTray(); renderStatus(); } });

// reply
function setReply(id) {
  S.replyTo = id; $('replyBar').hidden = !id;
  if (id) { $('replyText').textContent = plain(S.msgs.get(id)); input.focus(); }
}
$('replyX').onclick = () => setReply(null);

// ---------- voice notes ----------
let rec = null;
$('micBtn').onclick = startRec;
async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice notes are not supported here');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return toast('Microphone permission is off'); }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const an = ctx.createAnalyser(); an.fftSize = 256; ctx.createMediaStreamSource(stream).connect(an);
  rec = { mr, chunks, stream, ctx, an, start: Date.now(), type: mr.mimeType || type, levels: [] };
  mr.start(250);
  $('bar').hidden = true; $('rec').hidden = false;
  if (navigator.vibrate) navigator.vibrate(15);
  drawWave();
}
function drawWave() {
  if (!rec) return;
  const c = $('wave'), g = c.getContext('2d'), w = c.clientWidth * devicePixelRatio, h = c.clientHeight * devicePixelRatio;
  c.width = w; c.height = h;
  const data = new Uint8Array(rec.an.fftSize); rec.an.getByteTimeDomainData(data);
  let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
  rec.levels.push(peak / 128); if (rec.levels.length > 80) rec.levels.shift();
  g.clearRect(0, 0, w, h); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  const bw = w / 80;
  rec.levels.forEach((l, i) => { const bh = Math.max(2 * devicePixelRatio, l * h * 1.6); g.fillRect(i * bw, (h - bh) / 2, bw * .6, Math.min(bh, h)); });
  $('recTime').textContent = dur((Date.now() - rec.start) / 1000);
  requestAnimationFrame(drawWave);
}
function stopRec() {
  return new Promise(resolve => {
    const r = rec; rec = null;
    $('rec').hidden = true; $('bar').hidden = false;
    if (!r) return resolve(null);
    r.mr.onstop = () => { r.stream.getTracks().forEach(t => t.stop()); r.ctx.close(); resolve(r); };
    r.mr.stop();
  });
}
$('recCancel').onclick = () => stopRec();
$('recSend').onclick = async () => {
  const r = await stopRec();
  if (!r || Date.now() - r.start < 700) return toast('Too short');
  const ext = r.type.includes('mp4') ? 'm4a' : 'webm';
  const blob = new Blob(r.chunks, { type: r.type.split(';')[0] || 'audio/webm' });
  const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
  S.uploads = []; addUpload(file, 'voice'); renderTray(); $('tray').hidden = true;
  send('');
};

// voice playback
let playing = null;
document.addEventListener('click', e => {
  const btn = e.target.closest('.voice .play'); if (!btn) return;
  const box = btn.closest('.voice');
  if (playing?.box === box) { playing.a.paused ? playing.a.play() : playing.a.pause(); return; }
  if (playing) { playing.a.pause(); playing.box.querySelector('.play').innerHTML = ICON_PLAY; }
  const a = new Audio(box.dataset.src); playing = { a, box };
  a.ontimeupdate = () => { box.querySelector('.track i').style.width = (a.currentTime / (a.duration || 1) * 100) + '%'; box.querySelector('.dur').textContent = dur(a.currentTime); };
  a.onplay = () => btn.innerHTML = ICON_PAUSE; a.onpause = () => btn.innerHTML = ICON_PLAY;
  a.onended = () => { btn.innerHTML = ICON_PLAY; box.querySelector('.track i').style.width = '0'; };
  a.play().catch(() => toast('Could not play'));
});

// ---------- message interactions ----------
$('msgs').addEventListener('click', e => {
  const tt = e.target.closest('.tbl-tools [data-tt]');
  if (tt) return tableTool(tt);
  const act = e.target.closest('[data-act]');
  if (act && act.closest('.acts, .retry-row')) {
    const m = S.msgs.get(act.closest('.m').dataset.id); if (!m) return;
    if (act.dataset.act === 'reply') setReply(m.id);
    else if (act.dataset.act === 'retry') retryOpus(m.id);
    else { navigator.clipboard?.writeText(m.text || m.transcript || ''); toast('Copied'); }
    return;
  }
  const chip = e.target.closest('[data-chip]');
  if (chip && !chip.disabled) {
    const id = chip.closest('.m')?.dataset.id;
    const text = chip.dataset.chip;
    if (localCmd(text)) return command(localCmd(text), id);
    return send(text, id ? { chose: id } : {});
  }
  const img = e.target.closest('[data-view]');
  if (img) { openViewer(img.dataset.view); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { navigator.clipboard?.writeText(cp.parentElement.querySelector('code')?.innerText || ''); cp.textContent = 'Copied'; setTimeout(() => cp.textContent = 'Copy', 1200); }
});
// ---------- image viewer: pinch / drag / double-tap zoom (the page itself has zoom off) ----------
const V = { s: 1, x: 0, y: 0, start: null, lastTap: 0, tapTimer: null, moved: false };
const vimg = $('viewerImg');
function vApply(anim) { vimg.classList.toggle('anim', !!anim); vimg.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.s})`; }
function vReset(anim) { V.s = 1; V.x = 0; V.y = 0; vApply(anim); }
function openViewer(src) {
  vimg.src = src; $('viewerOpen').href = src; vReset(); $('viewer').hidden = false;
  const h = $('viewerHint'); h.style.opacity = 1; setTimeout(() => h.style.opacity = 0, 2200);
}
function closeViewer() { $('viewer').hidden = true; vimg.src = ''; vReset(); }
$('viewerX').onclick = e => { e.stopPropagation(); closeViewer(); };
const vCenter = () => { const r = $('viewer').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
function vZoomAt(px, py, s2, s1 = V.s, x1 = V.x, y1 = V.y) {   // keep the point under (px,py) fixed
  const c = vCenter();
  V.x = (px - c.x) - (s2 / s1) * (px - c.x - x1);
  V.y = (py - c.y) - (s2 / s1) * (py - c.y - y1);
  V.s = s2;
}
function vClamp() {
  if (V.s <= 1.01) { V.s = 1; V.x = 0; V.y = 0; return; }
  const w = vimg.offsetWidth * V.s, h = vimg.offsetHeight * V.s, W = innerWidth, H = innerHeight;   // layout size × zoom
  const mx = Math.max(0, (w - W) / 2), my = Math.max(0, (h - H) / 2);
  V.x = Math.min(mx, Math.max(-mx, V.x)); V.y = Math.min(my, Math.max(-my, V.y));
}
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
$('viewer').addEventListener('touchstart', e => {
  e.preventDefault();
  const ts = e.touches;
  if (ts.length === 2) V.start = { pinch: true, d: dist(ts[0], ts[1]), m: mid(ts[0], ts[1]), s: V.s, x: V.x, y: V.y };
  else if (ts.length === 1) { V.start = { pinch: false, px: ts[0].clientX, py: ts[0].clientY, x: V.x, y: V.y }; V.moved = false; }
}, { passive: false });
$('viewer').addEventListener('touchmove', e => {
  e.preventDefault(); const st = V.start, ts = e.touches; if (!st) return;
  if (st.pinch && ts.length >= 2) {
    const m = mid(ts[0], ts[1]), s = Math.min(6, Math.max(1, st.s * dist(ts[0], ts[1]) / st.d));
    vZoomAt(st.m.x, st.m.y, s, st.s, st.x, st.y);
    V.x += m.x - st.m.x; V.y += m.y - st.m.y; V.moved = true; vApply();
  } else if (!st.pinch && ts.length === 1) {
    const dx = ts[0].clientX - st.px, dy = ts[0].clientY - st.py;
    if (Math.abs(dx) + Math.abs(dy) > 6) V.moved = true;
    if (V.s > 1) { V.x = st.x + dx; V.y = st.y + dy; vApply(); }
  }
}, { passive: false });
$('viewer').addEventListener('touchend', e => {
  e.preventDefault();
  if (e.touches.length === 1) { V.start = { pinch: false, px: e.touches[0].clientX, py: e.touches[0].clientY, x: V.x, y: V.y }; return; }
  if (e.touches.length) return;
  const st = V.start; V.start = null;
  if (st?.pinch || V.moved) { vClamp(); vApply(true); return; }
  if (e.target.closest('#viewerX, #viewerOpen')) { e.target.closest('#viewerX, #viewerOpen').click(); return; }
  const now = Date.now(), p = e.changedTouches[0];
  if (now - V.lastTap < 300) {                                   // double tap: zoom in on that spot / reset
    clearTimeout(V.tapTimer); V.lastTap = 0;
    if (V.s > 1) vReset(true); else { vZoomAt(p.clientX, p.clientY, 2.5); vClamp(); vApply(true); }
  } else {
    V.lastTap = now;
    V.tapTimer = setTimeout(() => { if (V.s === 1) closeViewer(); }, 300);   // single tap closes when not zoomed
  }
}, { passive: false });
$('viewer').addEventListener('wheel', e => {                     // desktop: scroll to zoom
  e.preventDefault(); vZoomAt(e.clientX, e.clientY, Math.min(6, Math.max(1, V.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); vClamp(); vApply();
}, { passive: false });
$('viewer').addEventListener('click', e => { if (!isTouch && !e.target.closest('#viewerOpen')) { if (V.s === 1) closeViewer(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('viewer').hidden) closeViewer(); });

let pressTimer = null;
function openPop(bubble, x, y) {
  const id = bubble.closest('.m').dataset.id, m = S.msgs.get(id); if (!m) return;
  const p = $('pop');
  p.innerHTML = `<button data-act="reply">Reply</button>${m.text || m.transcript ? '<button data-act="copy">Copy text</button>' : ''}${m.from === 'agent' && !m.readonly && !onOpus() ? '<button data-act="retry">Ask again with Opus</button>' : ''}`;
  p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = Math.min(Math.max(10, x - r.width / 2), innerWidth - r.width - 10) + 'px';
  p.style.top = Math.max(60, y - r.height - 12) + 'px';
  p.onclick = ev => {
    const a = ev.target.dataset.act; p.hidden = true;
    if (a === 'reply') setReply(id);
    if (a === 'copy') { navigator.clipboard?.writeText(m.text || m.transcript || ''); toast('Copied'); }
    if (a === 'retry') retryOpus(id);
  };
  if (navigator.vibrate) navigator.vibrate(10);
}
$('msgs').addEventListener('touchstart', e => {
  const b = e.target.closest('.bubble'); if (!b) return;
  const t = e.touches[0];
  pressTimer = setTimeout(() => openPop(b, t.clientX, t.clientY), 450);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(ev => $('msgs').addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));
$('msgs').addEventListener('contextmenu', e => { const b = e.target.closest('.bubble'); if (b) { e.preventDefault(); openPop(b, e.clientX, e.clientY); } });
document.addEventListener('click', e => { if (!e.target.closest('#pop')) $('pop').hidden = true; }, true);

// ---------- table tools (copy, image, Excel/CSV, chart) ----------
function tableTool(btn) {
  const wrap = btn.closest('.tbl-tools').previousElementSibling, table = wrap?.querySelector('table'); if (!table) return;
  const k = btn.dataset.tt, stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  if (k === 'copy') {
    navigator.clipboard?.writeText(tableTSV(table)).then(() => toast('Table copied. Paste into Sheets or Excel'), () => toast('Could not copy'));
  } else if (k === 'image') {
    const blob = tableImage(wrap);   // the clipboard write must start inside the tap, so hand it the promise
    const viaFile = () => blob.then(b => saveFile(new File([b], `agent-table-${stamp}.png`, { type: 'image/png' })));
    if (window.ClipboardItem && navigator.clipboard?.write) {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => toast('Table image copied'), () => viaFile());
    } else viaFile();
  } else if (k === 'csv') {
    saveFile(new File(['\ufeff' + tableCSV(table)], `agent-table-${stamp}.csv`, { type: 'text/csv' }));
  } else if (k === 'chart') {
    const next = btn.closest('.tbl-tools').nextElementSibling;
    if (next?.classList.contains('from-table')) { next.remove(); btn.classList.remove('on'); return; }
    const spec = tableChartSpec(table);
    if (!spec) return toast('Nothing to chart in this table');
    btn.closest('.tbl-tools').insertAdjacentHTML('afterend', renderChart(spec).replace('class="viz"', 'class="viz from-table"')); btn.classList.add('on');

  }
}

// ---------- Today panel ----------
$('todayBtn').onclick = () => { $('sheet').hidden = true; $('today').hidden = false; loadToday(); };
$('today').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { $('today').hidden = true; return; }
  const q = e.target.closest('[data-ask]');
  if (q) { $('today').hidden = true; send(q.dataset.ask); }
  const job = e.target.closest('.job'); if (job) job.classList.toggle('open');
});
async function loadToday() {
  $('todayWhen').textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  try {
    const t = await api('/api/today');
    const ok = j => j.last ? (j.last.ok ? '<span class="dot ok"></span>' : '<span class="dot bad"></span>') : '<span class="dot"></span>';
    $('todayBody').innerHTML = `
      <div class="sheet-sec" style="margin-top:4px">Waiting on you</div>
      ${t.pending.length ? `<ol class="today-list">${t.pending.map(p => `<li>${p.tag ? `<span class="badge">${esc(p.tag)}</span> ` : ''}${esc(p.text)}</li>`).join('')}</ol>` : '<p class="fine">Nothing pending.</p>'}
      <div class="sheet-sec">Quick checks</div>
      <div class="row2"><button data-ask="What’s pending on me?">Pending</button><button data-ask="What did you do today?">Today’s work</button></div>
      <div class="sheet-sec">Scheduled jobs</div>
      <div class="jobs">${t.jobs.map(j => `<div class="job">
        <div class="job-top">${ok(j)}<b>${esc(j.title)}</b><span>${esc(j.when)}</span></div>
        <div class="job-last">${j.last ? `${esc(j.last.at)} · ${j.last.ok ? 'done' : j.last.timedOut ? 'timed out' : 'failed'}` : 'Not run yet'}${j.next ? ` · next ${esc(j.next)}` : ''}</div>
        ${j.last?.summary ? `<div class="job-sum">${esc(j.last.summary)}</div>` : ''}
      </div>`).join('') || '<p class="fine">No scheduled jobs.</p>'}</div>`;
  } catch (e) { $('todayBody').innerHTML = `<p class="fine">Could not load: ${esc(e.message)}</p>`; }
}

// ---------- ask again with Opus ----------
async function retryOpus(id) {
  if (!confirm(`Ask this again with Opus (strongest model)? ${AGENT} switches back to the current model afterwards.`)) return;
  try { await api('/api/retry', { id }); } catch (e) { toast(e.message); }
}

// ---------- menu sheet ----------
$('menuBtn').onclick = () => { renderSheet(); $('sheet').hidden = false; };
$('sheet').addEventListener('click', async e => {
  if (e.target.closest('[data-close]')) { $('sheet').hidden = true; return; }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.cmd) { $('sheet').hidden = true; command(b.dataset.cmd); }
  if (b.dataset.send) {
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    $('sheet').hidden = true; send(b.dataset.send);
  }
});
function meter(name, v) {
  const pct = parseInt(v?.[0]) || 0;
  return `<div class="meter"><div class="lbl"><span>${name}</span><span>${v?.[1] ? 'resets ' + esc(v[1]) : ''}</span></div><div class="val">${esc(v?.[0] ?? '–')}</div><div class="bar2"><i style="width:${pct}%"></i></div></div>`;
}
function renderSheet() {
  const u = S.live.usage;
  $('usageBox').innerHTML = meter('5-hour', u?.five_hour) + meter('Week', u?.week);
  const br = S.live.browsers || {};
  $('liveRow').innerHTML = Object.keys(br).length
    ? Object.entries(br).map(([k, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>${k[0].toUpperCase() + k.slice(1)}</a>`).join('')
    : '<p class="fine">Live view links are not available right now.</p>';
  const nb = $('notifBtn');
  const granted = window.Notification && Notification.permission === 'granted';
  nb.textContent = granted ? 'Send a test notification' : 'Turn on notifications';
  $('installTip').hidden = !(isIOS && !standalone);
}
$('notifBtn').onclick = async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast(isIOS && !standalone ? 'Add to Home Screen first, then open it from there' : 'Notifications are not supported here');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications are blocked in Settings');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = Uint8Array.from(atob(S.vapid.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - S.vapid.length % 4) % 4)), c => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await api('/api/push', { subscription: sub.toJSON() });
    await api('/api/push/test', {});
    toast('Notifications are on'); renderSheet();
  } catch (e) { toast('Could not turn on: ' + e.message); }
};

// ---------- Customize (prefs.js applies the choices) ----------
const ACCENT_NAMES = { saffron: 'Saffron', rose: 'Rose', violet: 'Violet', blue: 'Blue', teal: 'Teal', green: 'Green' };
$('czAccent').innerHTML = Object.entries(ACCENTS).map(([k, a]) =>
  `<button data-v="${k}" aria-label="${ACCENT_NAMES[k]}" title="${ACCENT_NAMES[k]}" style="background:linear-gradient(135deg, ${a[3]}, ${a[4]})"></button>`).join('');
function renderCustom() {
  const mark = (id, v) => { for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === v); };
  mark('czTheme', PREFS.theme || 'auto'); mark('czAccent', PREFS.accent || 'saffron'); mark('czText', PREFS.text || 'm');
  $('avReset').hidden = !PREFS.avatar;
}
async function savePrefs(change) {
  const before = PREFS;
  applyPrefs({ ...PREFS, ...change }); renderCustom();
  try { applyPrefs(await api('/api/prefs', change)); renderCustom(); }
  catch (e) { applyPrefs(before); renderCustom(); toast('Could not save: ' + e.message); }
}
$('customBtn').onclick = () => { $('sheet').hidden = true; renderCustom(); $('custom').hidden = false; };
$('custom').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { $('custom').hidden = true; return; }
  const b = e.target.closest('button[data-v]'); if (!b) return;
  const key = { czTheme: 'theme', czAccent: 'accent', czText: 'text' }[b.parentElement.id];
  if (key) savePrefs({ [key]: b.dataset.v });
});
$('avPick').onclick = () => $('avFile').click();
$('avFile').onchange = async () => {
  const f = $('avFile').files[0]; $('avFile').value = '';
  if (!f) return;
  try {   // centre-crop to a 512 px square JPEG in the browser (also turns HEIC from the iPhone into JPEG)
    const img = await createImageBitmap(f);
    const side = Math.min(img.width, img.height), c = document.createElement('canvas');
    c.width = c.height = Math.min(512, side);
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    applyPrefs(await api('/api/prefs/avatar', blob, { headers: { 'Content-Type': 'image/jpeg' } })); renderCustom();
    toast('Profile picture updated');
  } catch (e) { toast('Could not use that photo: ' + e.message); }
};
$('avReset').onclick = async () => {
  try { applyPrefs(await api('/api/prefs/avatar', new Blob([]))); renderCustom(); toast('Back to the original picture'); }
  catch (e) { toast('Could not reset: ' + e.message); }
};
api('/api/prefs').then(p => applyPrefs(p)).catch(() => {});
api('/api/suggestions').then(r => { S.suggest = r.items; if (!S.order.length) layout(); }).catch(() => {});

// ---------- swipe a bottom sheet down to close it ----------
for (const sheet of [$('sheet'), $('custom'), $('today')]) {
  const card = sheet.querySelector('.sheet-card');
  let y0 = 0, t0 = 0, dy = 0, drag = false, track = false;
  card.addEventListener('touchstart', e => {
    track = card.scrollTop <= 0; drag = false; dy = 0;   // only when scrolled to the top, so scrolling the sheet still works
    y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    if (!track) return;
    dy = e.touches[0].clientY - y0;
    if (!drag && dy > 8) { drag = true; card.style.transition = 'none'; }
    if (!drag) { if (dy < -8) track = false; return; }
    e.preventDefault();
    card.style.transform = `translateY(${Math.max(0, dy)}px)`;
    sheet.querySelector('.sheet-bg').style.opacity = String(Math.max(0, 1 - dy / card.offsetHeight));
  }, { passive: false });
  const end = () => {
    if (!drag) return;
    drag = track = false;
    const close = dy > card.offsetHeight / 4 || dy / Math.max(1, Date.now() - t0) > 0.5;
    card.style.transition = 'transform .22s ease-out';
    card.style.transform = close ? 'translateY(100%)' : '';
    setTimeout(() => {
      if (close) sheet.hidden = true;
      card.style.transition = card.style.transform = ''; sheet.querySelector('.sheet-bg').style.opacity = '';
    }, 220);
  };
  card.addEventListener('touchend', end); card.addEventListener('touchcancel', end);
}

// ---------- toast ----------
let toastTimer;
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 2600); }

// ---------- fit the visible area (iOS toolbars + keyboard) ----------
// The app box always matches the visual viewport, so there is no gap under the composer and it sits right on the
// keyboard. With the keyboard open the bottom safe-area padding is dropped (body.kb).
// iOS 26/27 Home Screen apps report a viewport 62 pt shorter than the screen (the status bar height) although the page
// starts at the very top, leaving a blank strip under the composer. 100lvh is the true screen height there, so add the
// difference back (standalone only; in Safari lvh differs for its own toolbars).
function lvh() { const e = document.createElement('div'); e.style.cssText = 'position:fixed;top:0;height:100lvh;width:1px;visibility:hidden'; document.body.appendChild(e); const h = e.getBoundingClientRect().height; e.remove(); return h; }
let iosGap = 0;
// Tested 2026-10-24: iOS clips drawing below innerHeight, so the strip can't be used. Instead drop the bottom
// safe-area padding (that area is already outside the viewport) via body.ios-short.
// Since the status bar is opaque ("black", 2026-10-24; "default" and no tag look the same: iOS paints it black outside the web view) iOS no longer shortens the viewport, so the normal bottom
// safe-area padding applies. ios-short only kicks in if the page ever runs under a translucent status bar again.
function measureGap() {
  const e = document.createElement('div'); e.style.cssText = 'position:fixed;top:0;padding-top:env(safe-area-inset-top);visibility:hidden';
  document.body.appendChild(e); const top = parseFloat(getComputedStyle(e).paddingTop) || 0; e.remove();
  iosGap = 0; document.body.classList.toggle('ios-short', standalone && top > 0 && lvh() - window.innerHeight > 20);
}
measureGap(); window.addEventListener('orientationchange', () => setTimeout(() => { measureGap(); fit(); }, 400));
let fitQueued = false;
function fit() {   // at most once per frame: several viewport events arrive together while the keyboard moves
  if (fitQueued) return; fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitNow(); });
}
function fitNow() {
  const vv = window.visualViewport; if (!vv) return;
  const app = $('app');
  app.style.height = (vv.height + iosGap) + 'px';
  app.style.transform = `translateY(${vv.offsetTop}px)`;
  document.body.classList.toggle('kb', window.innerHeight - vv.height > 120 || (document.activeElement === input && isTouch && window.innerHeight - vv.height > 60));
  if (S.atBottom) thread.scrollTop = thread.scrollHeight;
}
if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); fit(); }, { passive: true });
input.addEventListener('focus', () => { S.atBottom = true; setTimeout(fit, 350); });
// Tapping the composer: iOS first slides the whole page up to show the field, then the app resizes to the keyboard
// and the page snaps back down, which looks like a jitter. Focusing it ourselves with preventScroll skips the slide;
// the app box still follows the keyboard through visualViewport.
if (isIOS) input.addEventListener('touchend', e => {
  if (document.activeElement === input) return;   // already typing: leave caret taps alone
  e.preventDefault(); input.focus({ preventScroll: true });
});
input.addEventListener('blur', () => setTimeout(fit, 100));
fit();

// ---------- stay pinned to the latest message while the thread or the work card grows ----------
S.atBottom = true;
// Only the owner's own scrolling un-pins the thread. Scroll events from our smooth scroll (or from content growing)
// used to un-pin it half way, so a reply that grew afterwards (markdown, buttons, the work card going away) ended up
// a little above the bottom.
let userScrollAt = 0;
for (const ev of ['touchstart', 'touchmove', 'wheel', 'keydown']) thread.addEventListener(ev, () => { userScrollAt = Date.now(); }, { passive: true });
thread.addEventListener('scroll', () => {
  if (nearBottom()) S.atBottom = true;
  else if (Date.now() - userScrollAt < 1500) S.atBottom = false;
}, { passive: true });
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => { if (S.atBottom) thread.scrollTop = thread.scrollHeight; });
  [thread, $('msgs'), $('work')].forEach(el => ro.observe(el));
}


// ---------- sessions sidebar ----------
function updatePast() {
  const past = !S.follow;
  $('composer').hidden = past; $('pastBar').hidden = !past;
  if (past) {
    const first = S.msgs.get(S.order[0]);
    $('pastWhen').textContent = first ? `${dayLabel(first.ts)} ${clock(first.ts)}` : '';
    $('work').hidden = true;
  }
}
function openSide() { $('side').hidden = false; $('side').classList.remove('closing'); loadSessions(); }
function closeSide() { const s = $('side'); if (s.classList.contains('docked')) return; s.classList.add('closing'); setTimeout(() => { s.hidden = true; s.classList.remove('closing'); }, 190); }
$('sideBtn').onclick = openSide;
$('side').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return closeSide();
  const h = e.target.closest('[data-hide]');
  if (h) return hideSession(h.dataset.hide, h.dataset.hidden !== '1');
  if (e.target.closest('[data-toggle-hidden]')) { showHidden = !showHidden; return renderSessions(); }
  const b = e.target.closest('[data-sess]'); if (!b) return;
  if (b.parentElement.classList.contains('open')) return closeSwipe();   // tap on a swiped row just closes it
  closeSide(); loadThread(b.dataset.sess).catch(err => toast(err.message));
});
// Hide / unhide a session in the sidebar (the transcript stays on the laptop).
let showHidden = false;
async function hideSession(id, hidden) {
  try {
    await api('/api/sessions/hide', { id, hidden });
    const s = sessData?.sessions.find(x => x.id === id); if (s) s.hidden = hidden;
    renderSessions(); toast(hidden ? 'Session hidden' : 'Session is back in the list');
  } catch (e) { toast(e.message); }
}
// Swipe a session left to show its Hide button (touch). With a mouse the button shows on hover.
let swipe = null;
const closeSwipe = () => { for (const r of $('sideList').querySelectorAll('.sess-row.open')) { r.classList.remove('open'); r.querySelector('.sess').style.transform = ''; } };
$('sideList').addEventListener('touchstart', e => {
  const row = e.target.closest('.sess-row'), t = e.touches[0];
  if (!row?.querySelector('.sess-act')) { swipe = null; return; }
  swipe = { row, x: t.clientX, y: t.clientY, base: row.classList.contains('open') ? -88 : 0, on: false };
}, { passive: true });
$('sideList').addEventListener('touchmove', e => {
  if (!swipe) return;
  const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (!swipe.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }   // vertical: let the list scroll
    if (Math.abs(dx) < 10) return;
    swipe.on = true; if (!swipe.row.classList.contains('open')) closeSwipe();
    swipe.row.classList.add('swiping');
  }
  e.preventDefault();
  const sess = swipe.row.querySelector('.sess');
  sess.style.transition = 'none'; sess.style.transform = `translateX(${Math.min(0, Math.max(-110, swipe.base + dx))}px)`;
  swipe.dx = dx;
}, { passive: false });
$('sideList').addEventListener('touchend', () => {
  if (!swipe?.on) { swipe = null; return; }
  const sess = swipe.row.querySelector('.sess'), open = swipe.base + swipe.dx < -44;
  sess.style.transition = ''; sess.style.transform = open ? 'translateX(-88px)' : '';
  swipe.row.classList.toggle('open', open); swipe.row.classList.remove('swiping'); swipe = null;
});
const CH = { telegram: 'TG', whatsapp: 'WA', app: 'App' };
const ctxLabel = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'K';
let sessData = null;
async function loadSessions() {
  try { sessData = await api('/api/sessions'); S.current = sessData.current; renderSessions(); }
  catch (e) { $('sideList').innerHTML = `<p class="fine" style="padding:16px">Could not load sessions: ${esc(e.message)}</p>`; }
}
$('sideSearch').addEventListener('input', () => renderSessions());
function renderSessions() {
  const r = sessData; if (!r) return;
  {
    const q = $('sideSearch').value.trim().toLowerCase();
    const groups = {};
    const nHidden = r.sessions.filter(s => s.hidden).length;
    for (const s of r.sessions.filter(s => (showHidden || !s.hidden) && (!q || s.title.toLowerCase().includes(q)))) (groups[dayLabel(s.end)] ||= []).push(s);
    $('sideList').innerHTML = Object.entries(groups).map(([day, list]) => `<div class="side-group">${esc(day)}</div>` + list.map(s => `
      <div class="sess-row${s.hidden ? ' hid' : ''}">${s.id === r.current ? '' : `<button class="sess-act" data-hide="${s.id}" data-hidden="${s.hidden ? 1 : 0}" title="${s.hidden ? 'Unhide' : 'Hide'}">
        ${s.hidden ? '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>Unhide'
          : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.7-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>Hide'}</button>`}
      <button class="sess${s.id === S.session ? ' on' : ''}" data-sess="${s.id}">
        <div class="st">${esc(s.title.replace(/[*_`#]/g, ''))}</div>
        <div class="sm">${s.id === r.current ? '<span class="badge now">Live</span>' : ''}${clock(s.end)} · ${s.count} msg${s.count === 1 ? '' : 's'}
          ${s.channels.map(c => `<span class="badge">${CH[c] || c}</span>`).join('')}</div>
        ${s.ctx ? `<div class="ctx${s.ctx / r.window > .5 ? ' hi' : ''}"><i style="width:${Math.min(100, s.ctx / r.window * 100).toFixed(1)}%"></i><span>${ctxLabel(s.ctx)} of ${ctxLabel(r.window)} context</span></div>` : ''}
      </button></div>`).join('')).join('') + (nHidden ? `<button class="show-hidden" data-toggle-hidden>${showHidden ? 'Hide hidden sessions' : `Show hidden sessions (${nHidden})`}</button>` : '')
      || `<p class="fine" style="padding:16px">${q ? 'No matching sessions.' : 'No sessions yet.'}</p>`;
  }
}
$('newSession').onclick = async () => {
  if (!confirm('Start a fresh session? Memory and notes are kept. This also applies to Telegram.')) return;
  closeSide();
  if (!S.follow) await loadThread(S.current);
  send('/new');
};
$('pastBack').onclick = () => loadThread(S.current);
$('pastResume').onclick = async () => {
  if (!confirm(`Continue this session? ${AGENT} restarts with it (about 30 seconds). Telegram switches too.`)) return;
  try { S.pendingResume = S.session; await api('/api/sessions/resume', { id: S.session }); toast('Switching… back in about 30 seconds'); }
  catch (e) { S.pendingResume = ''; toast('Could not switch: ' + e.message); }
};
// swipe in from the left edge to open
let edge = null;
document.addEventListener('touchstart', e => { const t = e.touches[0]; edge = t.clientX < 24 && $('side').hidden && $('viewer').hidden ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
document.addEventListener('touchmove', e => {
  if (!edge) return; const t = e.touches[0];
  if (t.clientX - edge.x > 60 && Math.abs(t.clientY - edge.y) < 50) { edge = null; openSide(); }
}, { passive: true });

// ---------- desktop layout ----------
const deskMQ = matchMedia('(min-width: 1024px)');
let panelOn = true; try { panelOn = localStorage.getItem('panel') !== '0'; } catch {}
function applyDesk() {
  const d = deskMQ.matches, side = $('side');
  document.body.classList.toggle('desk', d);
  side.classList.toggle('docked', d);
  if (d) { side.hidden = false; side.classList.remove('closing'); loadSessions(); } else side.hidden = true;
  const showPanel = d && panelOn;
  document.body.classList.toggle('panel-on', showPanel); $('panel').hidden = !showPanel;
  renderPanel(); renderWork();
}
deskMQ.addEventListener('change', applyDesk);
function setPanel(on) { panelOn = on; try { localStorage.setItem('panel', on ? '1' : '0'); } catch {} applyDesk(); }
$('panelBtn').onclick = () => setPanel(!panelOn);
$('panelX').onclick = () => setPanel(false);
setInterval(() => { if ($('side').classList.contains('docked') && !document.hidden) loadSessions(); }, 60_000);

let panelTab = 'activity';
$('panel').querySelector('.panel-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  panelTab = b.dataset.tab;
  $('panel').querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $('panelActivity').hidden = panelTab !== 'activity'; $('panelBrowser').hidden = panelTab === 'activity';
  if (panelTab !== 'activity') {
    const url = S.live.browsers?.[panelTab]; const tok = url && new URL(url).searchParams.get('t');
    if (!tok) { $('liveFrame').removeAttribute('src'); $('liveNote').textContent = 'Live view is not available right now.'; return; }
    const src = '/lv?t=' + encodeURIComponent(tok);
    if ($('liveFrame').getAttribute('src') !== src) $('liveFrame').src = src;
    $('liveNote').textContent = `The ${panelTab} browser, live. Clicks and typing here go to that browser.`;
  } else { $('liveFrame').removeAttribute('src'); renderPanel(); }   // stop streaming when not shown
});
let histKey = '';
function renderPanel() {
  if ($('panel').hidden || panelTab !== 'activity') return;
  const box = $('panelActivity'), t = S.live.task, L = S.live;
  let top;
  if (busy() && t) {
    const steps = t.steps || [];
    top = `<div class="pa-card"><div class="pa-ask">${esc(t.text || '(message)')}</div>
      <div class="pa-meta"><span class="spinner" style="width:14px;height:14px"><i></i></span>${t.channel && t.channel !== 'app' ? esc(t.channel[0].toUpperCase() + t.channel.slice(1)) + ' · ' : ''}started ${clock(t.start * 1000)} · <b id="paTime">${dur(Date.now() / 1000 - t.start)}</b> · ${t.count || steps.length} steps</div>
      <ol class="pa-steps">${steps.map((x, i) => `<li class="${i === steps.length - 1 ? 'now' : ''}"><span class="t">+${dur(x.t - t.start)}</span>${stepHTML(x.s)}</li>`).join('') || '<li class="now"><span class="t"></span><span>Thinking…</span></li>'}</ol>
      <button class="pa-stop" id="paStop">Stop</button></div>`;
  } else {
    const txt = !S.sse ? 'Connecting…' : (L.state === 'offline' || !L.bridge) ? 'Offline · messages will wait' : `Idle · ${L.usage?.model || ''}`;
    top = `<div class="pa-card pa-idle"><span class="sdot" style="background:${!S.sse || !L.bridge ? 'var(--bad)' : 'var(--ok)'}"></span>${esc(txt)}</div>`;
  }
  const hist = L.history || [];
  const key = hist.map(h => h.start).join(',');
  let topEl = box.querySelector('#paTop');
  if (!topEl) { box.innerHTML = '<div id="paTop"></div><div class="pa-hist" id="paHist"></div>'; topEl = box.querySelector('#paTop'); histKey = ''; }
  topEl.innerHTML = top;
  if ($('paStop')) $('paStop').onclick = () => $('stopBtn').click();
  const steps = topEl.querySelector('.pa-steps'); if (steps) steps.lastElementChild?.scrollIntoView({ block: 'nearest' });
  if (key !== histKey) {
    histKey = key;
    $('paHist').innerHTML = hist.length ? '<div class="pa-h">Recent tasks</div>' + hist.map(h => `<details><summary>${esc(h.text || '(message)')}<span>${h.channel ? esc(h.channel) + ' · ' : ''}${clock(h.start * 1000)} · ${dur(h.secs || 0)} · ${h.count || 0} steps</span></summary>
      <ol class="pa-steps">${(h.steps || []).map(x => `<li><span class="t">+${dur(x.t - h.start)}</span>${stepHTML(x.s)}</li>`).join('')}</ol></details>`).join('') : '';
  }
}
setInterval(() => { const e = $('paTime'), t = S.live.task; if (e && t) e.textContent = dur(Date.now() / 1000 - t.start); }, 1000);

// drag & drop and paste files
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e) || !S.follow) return; dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  if (!S.follow) return toast('Switch to the live session to send files');
  for (const f of e.dataTransfer.files) addUpload(f); input.focus();
});
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f, i) => addUpload(f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
});

// keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); if (!$('side').classList.contains('docked')) openSide(); setTimeout(() => $('sideSearch').focus(), 50); return;
  }
  if (e.key === 'Escape') {
    if (!$('sheet').hidden) $('sheet').hidden = true;
    else if (!$('custom').hidden) $('custom').hidden = true;
    else if (!$('today').hidden) $('today').hidden = true;
    else if (!$('pop').hidden) $('pop').hidden = true;
    else if (S.replyTo) setReply(null);
    else if (!$('side').hidden && !$('side').classList.contains('docked')) closeSide();
    else if (document.activeElement === $('sideSearch')) { $('sideSearch').value = ''; renderSessions(); input.focus(); }
  }
  if (e.key === 'ArrowUp' && document.activeElement === input && !input.value) {   // recall your last message
    const last = [...S.order].reverse().map(id => S.msgs.get(id)).find(m => m.from === 'me' && !m.readonly && m.text);
    if (last) { e.preventDefault(); input.value = last.text; grow(); renderStatus(); }
  }
});
applyDesk();

// ---------- start ----------
(async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?t=' + encodeURIComponent(T)).catch(() => {});
  try { const st = await api('/api/state'); S.vapid = st.vapid; setLive(st); } catch {}
  await loadThread('').catch(() => toast('Could not load messages'));
  connect();
  renderStatus();
})();
