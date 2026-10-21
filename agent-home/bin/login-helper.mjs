// Login helper: a phone-friendly live view of the agent's Chrome, so you can sign in to websites yourself.
//
// - Streams the agent's browser tab (Chrome DevTools screencast) and sends your taps/typing back to it.
// - Your password goes phone -> this laptop -> the website. It never passes through Telegram or Claude.
// - Only answers devices on your Tailscale network (100.64.0.0/10, fd7a:115c:a1e0::/48) or this laptop,
//   and only with a valid, unexpired token: a login link (login-link.sh, one at a time) or a pinned link
//   (live-pin.json next to the token file, one per browser, kept by step-watch.py; Done doesn't expire it).
// - No npm packages: Node's built-in http + WebSocket client.
//
// Env: LOGIN_HELPER_PORT (8932), CDP_URL (http://127.0.0.1:9222), LOGIN_TOKEN_FILE (required)

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const PORT = Number(process.env.LOGIN_HELPER_PORT || 8932);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TOKEN_FILE = process.env.LOGIN_TOKEN_FILE;
if (!TOKEN_FILE) throw new Error('LOGIN_TOKEN_FILE is required');
const PIN_FILE = path.join(path.dirname(TOKEN_FILE), 'live-pin.json');
const BROWSER_CDP = { personal: 9222, work: 9223 };

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- access control ----------

function isAllowedAddress(addr) {
  if (!addr) return false;
  addr = addr.replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  const m = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127; // Tailscale CGNAT
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0:'); // Tailscale IPv6
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}

function sameToken(given, want) {
  if (!given || !want) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What a token opens: { kind: 'login' | 'pin', cdp, match } or null.
function session(given) {
  const t = readToken();
  if (t && Date.now() <= Number(t.expires) && sameToken(given, t.token)) return { kind: 'login', cdp: Number(t.cdp), match: t.match };
  let pin = null;
  try { pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch {}
  if (pin && Date.now() <= Number(pin.expires)) {
    for (const [browser, tok] of Object.entries(pin.tokens || {})) {
      if (BROWSER_CDP[browser] && sameToken(given, tok)) return { kind: 'pin', cdp: BROWSER_CDP[browser] };
    }
  }
  return null;
}

function expireToken() {
  const t = readToken();
  if (t) fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...t, expires: 0 }));
}

// ---------- Chrome DevTools connection ----------

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// Each link names its browser (personal/work) by DevTools port: the login token file's "cdp", or the pinned link's browser.
function cdpUrl(sess) {
  return sess && sess.cdp ? `http://127.0.0.1:${sess.cdp}` : CDP_URL;
}

async function listTabs(sess) {
  const res = await fetch(`${cdpUrl(sess)}/json/list`);
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && !/^(devtools|chrome-extension):/.test(t.url));
}

// One live session at a time (one phone viewing one tab).
const live = { cdp: null, tabId: null, frame: null, meta: null, url: '', title: '', clients: new Set() };

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of live.clients) res.write(payload);
}

async function attach(tabId, sess) {
  const tabs = await listTabs(sess);
  if (!tabs.length) throw new Error('no-tabs');
  let tab = tabs.find((t) => t.id === tabId);
  if (!tab) {
    const match = sess && sess.match;
    tab = (match && tabs.find((t) => t.url.toLowerCase().includes(String(match).toLowerCase()))) || tabs[0];
  }
  if (live.cdp && !live.cdp.closed && live.tabId === tab.id) return tab;
  if (live.cdp) live.cdp.close();

  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.ready;
  live.cdp = cdp; live.tabId = tab.id; live.url = tab.url; live.title = tab.title; live.frame = null;
  cdp.listeners.add((msg) => {
    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params;
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      live.frame = data; live.meta = metadata;
      broadcast('frame', { img: data, w: metadata.deviceWidth, h: metadata.deviceHeight });
    } else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
      live.url = msg.params.frame.url;
      broadcast('info', { url: live.url });
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1440, maxHeight: 2000 });
  log('attached to tab', tab.url);
  return tab;
}

// ---------- input ----------

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
};

async function handleInput(body) {
  const cdp = live.cdp;
  if (!cdp || cdp.closed) throw new Error('not-attached');
  const m = live.meta || { deviceWidth: 1440, deviceHeight: 900, offsetTop: 0 };
  const x = Math.round((body.fx ?? 0.5) * m.deviceWidth);
  const y = Math.round((body.fy ?? 0.5) * m.deviceHeight);
  switch (body.type) {
    case 'tap':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      break;
    case 'move': // trackpad cursor: lets menus open on hover
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      break;
    case 'scroll':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(body.dx) || 0, deltaY: Number(body.dy) || 0 });
      break;
    case 'text':
      await cdp.send('Input.insertText', { text: String(body.text ?? '') });
      break;
    case 'key': {
      const k = KEYS[body.key];
      if (!k) throw new Error('unknown key');
      await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: body.key, ...k });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: body.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
      break;
    }
    default:
      throw new Error('unknown input');
  }
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedAddress(req.socket.remoteAddress)) { req.socket.destroy(); return; }
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('t');
  const sess = session(token);
  if (!sess) {
    return send(res, 403, PAGE_EXPIRED, 'text/html; charset=utf-8');
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE.replace('__KIND__', sess.kind), 'text/html; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      live.clients.add(res);
      req.on('close', () => live.clients.delete(res));
      try {
        await attach(url.searchParams.get('tab'), sess);
        res.write(`event: info\ndata: ${JSON.stringify({ url: live.url, title: live.title })}\n\n`);
        if (live.frame) res.write(`event: frame\ndata: ${JSON.stringify({ img: live.frame, w: live.meta.deviceWidth, h: live.meta.deviceHeight })}\n\n`);
      } catch (e) {
        res.write(`event: problem\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/tabs') {
      const tabs = await listTabs(sess);
      return send(res, 200, tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, current: t.id === live.tabId })));
    }
    if (req.method === 'POST' && url.pathname === '/input') {
      await handleInput(await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/done') {
      if (sess.kind === 'login') expireToken();
      if (live.cdp) { live.cdp.send('Page.stopScreencast').catch(() => {}); live.cdp.close(); live.cdp = null; }
      log(`${sess.kind} session finished by user`);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => log(`login helper on :${PORT} (Tailscale + localhost only)`));

// ---------- pages ----------

const PAGE_EXPIRED = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Link expired</title><body style="font:16px system-ui;padding:24px;background:#111;color:#eee">
<h2>This login link has expired.</h2><p>Ask the agent on Telegram for a new one.</p></body>`;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>Agent login</title>
<style>
  :root { --bg:#111; --fg:#eee; --muted:#999; --btn:#2a2a2a; --accent:#3b82f6; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:2; background:#000; padding:8px 12px; display:flex; gap:8px; align-items:center; }
  #url { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:13px; }
  #view { position:relative; }
  #screen { width:100%; display:block; touch-action:pan-y; }
  #msg { padding:24px; color:var(--muted); }
  #dot { position:absolute; width:22px; height:22px; margin:-11px 0 0 -11px; border-radius:50%;
         border:2px solid var(--accent); pointer-events:none; opacity:0; transition:opacity .4s; }
  footer { position:sticky; bottom:0; background:#000; padding:8px; display:grid; gap:8px; }
  .row { display:flex; gap:6px; }
  input[type=text], input[type=password] { flex:1; min-width:0; padding:10px; border-radius:8px; border:1px solid #444;
         background:#1b1b1b; color:var(--fg); font-size:16px; }
  button { padding:10px 12px; border:0; border-radius:8px; background:var(--btn); color:var(--fg); font-size:15px; }
  button.primary { background:var(--accent); color:#fff; }
  select { background:var(--btn); color:var(--fg); border:0; border-radius:8px; padding:8px; max-width:40%; }
  .hint { color:var(--muted); font-size:12px; text-align:center; }
  #cursor { position:absolute; width:8px; height:8px; margin:-4px 0 0 -4px; border-radius:50%; background:#f43f5e;
            border:1px solid #fff; box-shadow:0 0 2px #000; pointer-events:none; display:none; }
  body.haspad { display:flex; flex-direction:column; min-height:100dvh; }
  #pad { flex:1; min-height:140px; margin:0 8px calc(16px + env(safe-area-inset-bottom)); border:1px dashed #444; border-radius:12px; background:#181818; touch-action:none;
         display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:13px; text-align:center;
         padding:12px; user-select:none; -webkit-user-select:none; }
  #pad.active { background:#1f2430; }
</style></head>
<body class="haspad">
<header><span id="url">connecting...</span><select id="tabs" title="Switch tab"></select></header>
<div id="view"><div id="msg">Connecting to the agent's browser...</div><img id="screen" alt=""><div id="dot"></div><div id="cursor"></div></div>
<footer>
  <div class="row">
    <input id="text" type="password" placeholder="Tap a field on the page, then type here" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button id="eye" title="Show/hide">Show</button>
    <button id="send" class="primary">Type</button>
  </div>
  <div class="row">
    <button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Backspace">Del</button>
    <button data-scroll="-500">Up</button><button data-scroll="500">Down</button>
    <button id="done" class="primary" style="margin-left:auto">Done</button>
  </div>
</footer>
<div id="pad">Trackpad<br>slide 1 finger = move pointer · tap = click<br>slide 2 fingers = scroll<br><br><small>You can also tap on the page to click. What you type goes straight to the laptop's browser, not to Telegram.</small></div>
<script>
const t = new URLSearchParams(location.search).get('t');
const KIND = '__KIND__';   // 'login' (one-time link) or 'pin' (pinned link, stays valid)
const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t);
const $ = (id) => document.getElementById(id);
let es, size = { w: 1440, h: 900 };

function connect(tab) {
  if (es) es.close();
  es = new EventSource(q('/stream' + (tab ? '?tab=' + encodeURIComponent(tab) : '')));
  es.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data); size = { w: f.w, h: f.h };
    $('screen').src = 'data:image/jpeg;base64,' + f.img; $('msg').style.display = 'none';
    showCursor();
  });
  es.addEventListener('info', (e) => { const i = JSON.parse(e.data); if (i.url) $('url').textContent = i.url; });
  es.addEventListener('problem', (e) => {
    const m = JSON.parse(e.data).message;
    $('msg').style.display = 'block';
    $('msg').textContent = m === 'no-tabs' ? "The agent's browser isn't open. Ask the agent to open the site first, then reload this page." : 'Problem: ' + m;
  });
  es.onerror = () => { $('url').textContent = 'reconnecting...'; };
  loadTabs();
}

async function post(path, body) {
  const r = await fetch(q(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (r.status === 403) { document.body.innerHTML = '<p style="padding:24px">This link has expired. Ask the agent for a new one.</p>'; }
  return r;
}

async function loadTabs() {
  const r = await fetch(q('/tabs')); if (!r.ok) return;
  const tabs = await r.json(), sel = $('tabs'); sel.innerHTML = '';
  for (const tb of tabs) {
    const o = document.createElement('option'); o.value = tb.id; o.textContent = tb.title || tb.url; o.selected = tb.current; sel.appendChild(o);
  }
}
$('tabs').onchange = (e) => connect(e.target.value);

$('screen').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  cur.x = fx; cur.y = fy; showCursor(); flashDot();
  post('/input', { type: 'tap', fx, fy });
});

// ---- trackpad: 1 finger moves the pointer, tap clicks, 2 fingers scroll ----
const cur = { x: 0.5, y: 0.5 };
const SPEED = 1.5, SCROLL = 3;
const clamp = (v) => Math.min(1, Math.max(0, v));
function showCursor() {
  const img = $('screen'), c = $('cursor'); if (!img.clientWidth) return;
  c.style.display = 'block'; c.style.left = (cur.x * img.clientWidth) + 'px'; c.style.top = (cur.y * img.clientHeight) + 'px';
}
function flashDot() {
  const img = $('screen'), d = $('dot');
  d.style.left = (cur.x * img.clientWidth) + 'px'; d.style.top = (cur.y * img.clientHeight) + 'px';
  d.style.opacity = 1; setTimeout(() => d.style.opacity = 0, 400);
}
let moveTimer = null, scrollTimer = null, scrollAcc = { x: 0, y: 0 };
function queueMove() {
  if (moveTimer) return;
  moveTimer = setTimeout(() => { moveTimer = null; post('/input', { type: 'move', fx: cur.x, fy: cur.y }); }, 80);
}
function queueScroll(dx, dy) {
  scrollAcc.x += dx; scrollAcc.y += dy; if (scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null; const s = scrollAcc; scrollAcc = { x: 0, y: 0 };
    post('/input', { type: 'scroll', dx: Math.round(-s.x * SCROLL), dy: Math.round(-s.y * SCROLL), fx: cur.x, fy: cur.y });
  }, 60);
}
const avg = (ts) => { let x = 0, y = 0; for (const t of ts) { x += t.clientX; y += t.clientY; } return { x: x / ts.length, y: y / ts.length }; };
let last = null, startAt = 0, moved = 0, fingers = 0;
const pad = $('pad');
pad.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) { startAt = Date.now(); moved = 0; fingers = 1; pad.classList.add('active'); }
  fingers = Math.max(fingers, e.touches.length); last = avg(e.touches);
}, { passive: false });
pad.addEventListener('touchmove', (e) => {
  e.preventDefault(); if (!last) return;
  const p = avg(e.touches), dx = p.x - last.x, dy = p.y - last.y; last = p; moved += Math.abs(dx) + Math.abs(dy);
  if (e.touches.length >= 2) { queueScroll(dx, dy); return; }
  const img = $('screen'); if (!img.clientWidth) return;
  cur.x = clamp(cur.x + dx * SPEED / img.clientWidth); cur.y = clamp(cur.y + dy * SPEED / img.clientHeight);
  showCursor(); queueMove();
}, { passive: false });
pad.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (e.touches.length) { last = avg(e.touches); return; }
  pad.classList.remove('active'); last = null;
  if (fingers === 1 && moved < 10 && Date.now() - startAt < 300) { flashDot(); post('/input', { type: 'tap', fx: cur.x, fy: cur.y }); }
}, { passive: false });
pad.addEventListener('touchcancel', () => { pad.classList.remove('active'); last = null; });
window.addEventListener('resize', showCursor);

$('send').onclick = async () => {
  const v = $('text').value; if (!v) return;
  await post('/input', { type: 'text', text: v }); $('text').value = '';
};
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('send').click(); } });
$('eye').onclick = () => { const i = $('text'); i.type = i.type === 'password' ? 'text' : 'password'; $('eye').textContent = i.type === 'password' ? 'Show' : 'Hide'; };
document.querySelectorAll('[data-key]').forEach((b) => b.onclick = () => post('/input', { type: 'key', key: b.dataset.key }));
document.querySelectorAll('[data-scroll]').forEach((b) => b.onclick = () => post('/input', { type: 'scroll', dy: Number(b.dataset.scroll), fx: 0.5, fy: 0.5 }));
$('done').onclick = async () => {
  await post('/done'); if (es) es.close();
  document.body.innerHTML = KIND === 'pin'
    ? '<div style="padding:24px;font:16px system-ui"><h2>Closed</h2><p>Open the pinned link in Telegram again whenever you want to watch.</p></div>'
    : '<div style="padding:24px;font:16px system-ui"><h2>Done</h2><p>This link is now closed. Go back to Telegram and reply <b>done</b> so the agent continues.</p></div>';
};
connect();
</script>
</body></html>`;
