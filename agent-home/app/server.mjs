#!/usr/bin/env node
// Agent app server: the owner's own chat app for the agent (a second channel next to Telegram).
//
// - Serves the web app (public/) and its API on 127.0.0.1:APP_PORT. The phone reaches it only through
//   `tailscale serve` (private HTTPS on the tailnet, never Funnel); every app request must carry the
//   Tailscale-User-Login header that serve adds, plus the app token (app.json).
// - Keeps the chat history, queues the owner's messages while the agent is down, and hands them to the
//   channel bridge (channel.mjs, running inside the main Claude session) over /bridge/* (localhost, bridge secret,
//   never via serve). Replies come back the same way.
// - Live steps: follows activity.json (written by bin/step-watch.py) and streams it to the app.
// - Web push notifications (VAPID) when no app window is open.
// Runs in tmux window "agent:app" (bin/start-app.sh restarts it). Survives Claude restarts.
//
// Env: APP_PORT (8950)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import webPush from 'web-push';

const HOME = os.homedir();
// Names from the setup wizard (~/.agent.env): shown in the app and used in messages.
const ENV_TXT = (() => { try { return fs.readFileSync(path.join(HOME, '.agent.env'), 'utf8'); } catch { return ''; } })();
const envVal = k => (ENV_TXT.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*\\S)\\s*$`, 'm')) || [])[1]?.replace(/^["']|["']$/g, '') || '';
const AGENT = envVal('AGENT_NAME') || 'Agent', OWNER = envVal('OWNER_NAME') || 'there';
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PORT = Number(process.env.APP_PORT || 8950);
const AGENT_HOME = path.join(HOME, 'agent-home');
const BIN = path.join(AGENT_HOME, 'bin');
const PUBLIC = path.join(AGENT_HOME, 'app', 'public');
const STATE = path.join(HOME, '.local/state/personal-agent');
const APP_STATE = path.join(STATE, 'app');
const MEDIA = path.join(APP_STATE, 'media');                       // files the agent sent (copies)
// Files the owner sends. Kept inside agent-home so the agent's browser may upload them (its allowed roots end there).
// Uploads before 2026-10-24 15:00 are in the old folder; /inbox/ serves from both.
const INBOX = path.join(AGENT_HOME, 'downloads', 'inbox', 'app');
const OLD_INBOX = path.join(HOME, '.claude/channels/app/inbox');
const MSG_FILE = path.join(APP_STATE, 'messages.json');
const CONF_FILE = path.join(APP_STATE, 'app.json');                 // { token, bridge } — never shown to Claude
const PUSH_FILE = path.join(APP_STATE, 'push.json');                // { vapid, subs: [] }
const ACTIVITY_FILE = path.join(STATE, 'activity.json');
const PIN_FILE = path.join(STATE, 'live-pin.json');
const STOP_FILE = path.join(STATE, 'stop-request');
const PROJ = path.join(HOME, '.claude/projects', AGENT_HOME.replaceAll('/', '-'));   // the agent's session transcripts
const SESS_DIR = path.join(HOME, '.claude/sessions');
const INDEX_FILE = path.join(APP_STATE, 'sessions-index.json');
const HIDDEN_FILE = path.join(APP_STATE, 'hidden-sessions.json');   // sessions hidden from the sidebar: { ids: [] } (transcripts untouched)
const PREFS_FILE = path.join(APP_STATE, 'prefs.json');              // Customize: { theme, accent, text, avatar }
const PREF_CHOICES = { theme: ['auto', 'light', 'dark'], accent: ['saffron', 'rose', 'violet', 'blue', 'teal', 'green'], text: ['s', 'm', 'l'] };
const MAX_UPLOAD = 60 * 1024 * 1024;
const KEEP = 5000;                                                  // messages kept in history

for (const d of [APP_STATE, MEDIA, INBOX]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- config + push keys ----------
const conf = readJson(CONF_FILE, {});
if (!conf.token || !conf.bridge) { conf.token ||= rid(24); conf.bridge ||= rid(24); writeJson(CONF_FILE, conf); log('created app.json'); }
const push = readJson(PUSH_FILE, { subs: [] });
if (!push.vapid) { push.vapid = webPush.generateVAPIDKeys(); writeJson(PUSH_FILE, push); log('created push keys'); }
webPush.setVapidDetails('mailto:personal-agent@example.com', push.vapid.publicKey, push.vapid.privateKey);

// ---------- messages ----------
// { id, ts, from: 'me'|'agent'|'system', text, files: [{name, url, kind, size, path?}], buttons, chosen,
//   reply_to, reactions: {emoji: true}, edited, status: 'queued'|'delivered'|'read' (owner messages; read = the agent started on it), transcript }
let messages = readJson(MSG_FILE, []);
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (messages.length > KEEP) messages = messages.slice(-KEEP); writeJson(MSG_FILE, messages); }, 300);
}
const byId = id => messages.find(m => m.id === id);
const publicMsg = m => ({ ...m, files: (m.files || []).map(({ path: _p, ...f }) => f) });

function addMessage(m) {
  m = { id: rid(8), ts: Date.now(), files: [], session: currentSession(), ...m };
  messages.push(m); save();
  broadcast('msg', publicMsg(m));
  return m;
}
function updateMessage(m) { save(); broadcast('msg', publicMsg(m)); }
// Double tick: every delivered owner message becomes 'read' once the agent works on, reacts to or answers it.
function markRead() {
  let n = 0;
  for (const m of messages) if (m.from === 'me' && m.status === 'delivered') { m.status = 'read'; n++; broadcast('msg', publicMsg(m)); }
  if (n) save();
}

// ---------- sessions (the agent's Claude sessions, shared by Telegram, WhatsApp and the app) ----------
// Index of every transcript: title (first owner message), times, message count, and the Telegram/WhatsApp exchanges
// (app messages live in messages.json). Read incrementally from a saved offset; cached in sessions-index.json.
let curSession = '';
function findCurrent() {
  try {
    for (const f of fs.readdirSync(SESS_DIR)) {
      const pid = f.replace(/\.json$/, '');
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { continue; }
      if (!cmd.includes('--channels')) continue;
      return readJson(path.join(SESS_DIR, f), {}).sessionId || '';
    }
  } catch {}
  return '';
}
const currentSession = () => curSession || (curSession = findCurrent());

const index = readJson(INDEX_FILE, { v: 4, files: {} });
if (index.v !== 4) { index.v = 4; index.files = {}; }   // v2 adds ctx (context size); v3 plain labels; v4 better titles
// A session is named after its first real question: commands, greetings and one-word messages are skipped.
const weakTitle = t => !t || t.startsWith('/') || t.length < 4 || t === '(photo)'
  || /^(hi+|hello|hey|hlo|ok(ay)?|thanks?( you)?|thx|namaste|munshi\s*ji|yo|test(ing)?|hmm+|done|yes|no|good morning)[\s!.?,]*$/i.test(t);
const chanOf = src => src.includes('telegram') ? 'telegram' : src.includes('whatsapp') ? 'whatsapp' : src === 'app' ? 'app' : '';
const tsOf = s => { const n = Date.parse(s); return Number.isFinite(n) ? n : 0; };
function cleanOwner(s) {
  return String(s).replace(/^\(voice note, transcribed\)\s*/, 'Voice: ').trim();
}
function scanLine(e, line) {
  if (!line.includes('"timestamp"')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  const ts = tsOf(d.timestamp); if (!ts) return;
  e.start ||= ts; e.end = Math.max(e.end || 0, ts);
  const c = d.message?.content;
  if (d.type === 'user' && line.includes('<channel')) {
    const texts = typeof c === 'string' ? [c] : (c || []).filter(b => b?.type === 'text').map(b => b.text);
    for (const tx of texts) for (const m of tx.matchAll(/<channel source="([^"]+)"([^>]*)>([\s\S]*?)<\/channel>/g)) {
      const ch = chanOf(m[1]); if (!ch) continue;
      let text = cleanOwner(m[3]);
      if (!text && /image_path=/.test(m[2])) text = '(photo)';
      e.count++; if (!e.title || (e.weak && !weakTitle(text))) { e.title = text.slice(0, 120); e.weak = weakTitle(text); }
      if (!e.channels.includes(ch)) e.channels.push(ch);
      if (ch !== 'app') e.items.push({ ts, from: 'me', ch, text: text.slice(0, 4000) });
    }
  } else if (d.type === 'assistant' && Array.isArray(c)) {
    const u = d.message?.usage;   // context in use at this reply (main thread only, not sub-agents)
    if (u && !d.isSidechain) e.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      const ch = /^mcp__plugin_telegram_telegram__reply$/.test(b.name) ? 'telegram' : b.name === 'mcp__whatsapp__reply' ? 'whatsapp' : '';
      if (!ch) continue;
      const files = (b.input?.files || []).map(f => 'Attachment: ' + path.basename(String(f)));
      e.items.push({ ts, from: 'agent', ch, text: [String(b.input?.text || ''), ...files].filter(Boolean).join('\n').slice(0, 8000) });
    }
  }
}
function scanFile(name) {
  const file = path.join(PROJ, name);
  let st; try { st = fs.statSync(file); } catch { return null; }
  let e = index.files[name];
  if (!e || st.size < e.offset) e = index.files[name] = { offset: 0, start: 0, end: 0, count: 0, title: '', channels: [], items: [] };
  if (st.size === e.offset) return e;
  const fd = fs.openSync(file, 'r');
  try {
    const CH = 8 << 20; let pos = e.offset, rest = '';
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CH, st.size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break;
      pos += n;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n'); rest = lines.pop();
      for (const l of lines) scanLine(e, l);
    }
    e.offset = pos - Buffer.byteLength(rest);   // re-read an unfinished last line next time
  } finally { fs.closeSync(fd); }
  return e;
}
let indexDirty = false;
function refreshIndex() {
  let names = [];
  try { names = fs.readdirSync(PROJ).filter(n => n.endsWith('.jsonl')); } catch {}
  for (const n of names) { const before = index.files[n]?.offset; scanFile(n); if (index.files[n]?.offset !== before) indexDirty = true; }
  for (const n of Object.keys(index.files)) if (!names.includes(n)) { delete index.files[n]; indexDirty = true; }
  if (indexDirty) { writeJson(INDEX_FILE, index); indexDirty = false; }
}
function sessionList() {
  refreshIndex();
  return Object.entries(index.files).filter(([, e]) => e.count > 0)
    .map(([n, e]) => ({ id: n.slice(0, -6), title: e.title || '(no title)', start: e.start, end: e.end, count: e.count, channels: e.channels, ctx: e.ctx || 0 }))
    .sort((a, b) => b.end - a.end);
}
function sessionItems(id) {
  const e = scanFile(`${id}.jsonl`);
  return (e?.items || []).map((x, i) => ({ id: `tx-${id.slice(0, 8)}-${i}`, ts: x.ts, from: x.from, text: x.text, files: [], via: x.ch, readonly: true }));
}
// Older app messages (before tagging): give each the session whose time range covers it.
function tagLegacy() {
  const list = sessionList(); let n = 0;
  for (const m of messages) if (!m.session) {
    const s = list.find(x => m.ts >= x.start - 60_000 && m.ts <= x.end + 120_000);
    if (s) { m.session = s.id; n++; }
  }
  if (n) { save(); log(`tagged ${n} older messages with their session`); }
}
setTimeout(() => { try { const t0 = Date.now(); tagLegacy(); log(`session index ready (${Object.keys(index.files).length} files, ${Date.now() - t0} ms)`); } catch (e) { log('index error', e.message); } }, 500);
setInterval(() => {
  const id = findCurrent();
  if (id && id !== curSession) { curSession = id; log('current session', id); broadcast('session', { current: id }); }
}, 2000);

// ---------- app clients (SSE) ----------
const clients = new Map();   // cid -> { res, visible }
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) c.res.write(payload);
}
const someoneLooking = () => [...clients.values()].some(c => c.visible);

function plain(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
// Returns true when the owner will see it: the app is open on screen, or at least one phone/laptop accepted the push.
async function notify(m) {
  if (someoneLooking()) return true;
  if (!push.subs.length) return false;
  const body = plain(m.text) || (m.files?.length ? `Attachment: ${m.files.map(f => f.name).join(', ')}` : 'New message');
  const payload = JSON.stringify({ title: AGENT, body: body.slice(0, 180), tag: m.id });
  const keep = []; let sent = 0;
  for (const sub of push.subs) {
    try { await webPush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }); keep.push(sub); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) log('push subscription expired, removed');
      else { keep.push(sub); log('push failed:', e.statusCode || '', String(e.body || e.message).slice(0, 120)); }
    }
  }
  if (keep.length !== push.subs.length) { push.subs = keep; writeJson(PUSH_FILE, push); }
  return sent > 0;
}

// ---------- bridge (channel.mjs inside Claude) ----------
let bridge = null;   // { res, id }
function bridgeSend(m) {
  if (!bridge) return false;
  const meta = { chat_id: 'app', message_id: m.id, user: OWNER, ts: new Date(m.ts).toISOString() };
  if (m.reply_to) meta.reply_to_id = m.reply_to;
  let content = m.text || '';
  const f = m.files?.[0];
  if (f) {
    if (f.kind === 'image') meta.image_path = f.path;
    else { meta.attachment_path = f.path; meta.attachment_kind = f.kind; meta.attachment_name = f.name; }
    if (m.files.length > 1) meta.more_files = m.files.slice(1).map(x => x.path).join(' ');
    if (f.kind === 'voice') {
      content = m.transcript ? `(voice note, transcribed) ${m.transcript}` : '(voice note — transcription failed; run `transcribe <attachment_path>`)';
    } else if (!content) content = f.kind === 'image' ? '(photo)' : `(file: ${f.name})`;
  }
  bridge.res.write(`event: inbound\ndata: ${JSON.stringify({ content, meta })}\n\n`);
  return true;
}
function flushQueue() { for (const m of messages) if (m.from === 'me' && m.status === 'queued' && !m.transcribing) bridgeSend(m); }
const bridgeState = () => broadcast('bridge', { connected: !!bridge });

function mediaFile(src) {
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error(`not a file: ${src}`);
  const name = path.basename(src);
  const stored = `${Date.now()}-${rid(4)}-${name.replace(/[^\w.\- ]/g, '_')}`;
  fs.copyFileSync(src, path.join(MEDIA, stored));
  return { name, url: `/media/${encodeURIComponent(stored)}`, kind: fileKind(name), size: st.size };
}
function fileKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.m4a', '.mp3', '.ogg', '.oga', '.opus', '.wav', '.aac'].includes(ext)) return 'audio';
  return 'file';
}

// ---------- activity (live steps) ----------
let activity = readJson(ACTIVITY_FILE, {});
function liveLinks() {
  const pin = readJson(PIN_FILE, null);
  if (!pin || Date.now() > Number(pin.expires)) return {};
  let ip = tsIp;
  return ip ? Object.fromEntries(Object.entries(pin.tokens || {}).map(([b, t]) => [b, `http://${ip}:8932/?t=${t}`])) : {};
}
const stateMsg = () => ({ state: activity.state || 'offline', task: activity.task || null, usage: activity.usage || null,
  bridge: !!bridge, browsers: liveLinks(), history: (activity.history || []).slice(0, 8) });

// Browser live view (bin/login-helper.mjs on 127.0.0.1:8932) relayed through this HTTPS origin so the desktop app can
// embed it (a plain-http frame inside an https page is blocked). The helper checks its own pinned token itself.
const LIVE_PATHS = new Set(['/lv', '/stream', '/tabs', '/input', '/done']);
function relayLive(req, res, url) {
  const p = http.request({ host: '127.0.0.1', port: 8932, method: req.method, path: (url.pathname === '/lv' ? '/' : url.pathname) + url.search,
    headers: { 'content-type': req.headers['content-type'] || 'application/json', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } },
  r => { res.writeHead(r.statusCode, { ...r.headers, 'X-Accel-Buffering': 'no' }); r.pipe(res); });
  p.on('error', e => { if (!res.headersSent) send(res, 502, { error: 'live view helper not running: ' + e.message }); });
  res.on('close', () => p.destroy());   // viewer went away (e.g. SSE closed)
  req.pipe(p);
}
fs.watchFile(ACTIVITY_FILE, { interval: 400 }, () => {
  const a = readJson(ACTIVITY_FILE, null);
  if (!a) return;
  const was = activity.state;
  activity = a; broadcast('state', stateMsg()); if (a.state === 'working') markRead();
  if (was === 'working' && a.state !== 'working') { setTimeout(rescueReply, 3000); setTimeout(finishOpusRetry, 4000); }
});

// Safety net: the agent sometimes ends a turn with the answer written only in his own window (no mcp__app__reply),
// so it never reaches the app. When he goes idle, if the last app message got no reply/react but he did write text
// after it, post that text here.
const rescued = new Set();
function rescueReply() {
  try {
    const f = path.join(PROJ, `${currentSession()}.jsonl`);
    const lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-400);
    let start = -1, msgId = '';
    lines.forEach((l, i) => {
      if (!l.includes('<channel source=')) return;
      try {
        const d = JSON.parse(l); if (d.type !== 'user') return;
        const c = d.message?.content, t = typeof c === 'string' ? c : (c || []).map(x => x.text || '').join(' ');
        const m = t.match(/<channel source="(\w+)"[^>]*message_id="([^"]+)"/);
        if (m) { start = m[1] === 'app' ? i : -1; msgId = m[2]; }
      } catch {}
    });
    if (start < 0 || rescued.has(msgId)) return;
    const asked = byId(msgId);   // already answered in the app (also after a restart of this server)?
    if (asked && messages.some(m => m.from === 'agent' && m.ts > asked.ts && m.session === asked.session)) return;
    const texts = [];
    for (const l of lines.slice(start + 1)) {
      let d; try { d = JSON.parse(l); } catch { continue; }
      if (d.type !== 'assistant') continue;
      for (const x of d.message?.content || []) {
        if (x.type === 'tool_use' && /^mcp__app__(reply|react)$/.test(x.name)) return;   // he answered properly
        if (x.type === 'text' && x.text.trim()) texts.push(x.text.trim());
      }
    }
    if (!texts.length) return;
    rescued.add(msgId);
    log('rescued an unsent reply to', msgId);
    markRead(); notify(addMessage({ from: 'agent', text: texts.at(-1), reply_to: byId(msgId) ? msgId : undefined }));
  } catch (e) { log('rescue check failed:', e.message); }
}
setTimeout(rescueReply, 4000);   // also catch one missed while the app server was down

let tsIp = '';
execFile('tailscale', ['ip', '-4'], (e, out) => { tsIp = e ? '' : String(out).trim().split(/\s+/)[0]; });

// ---------- local commands (no Claude) ----------
const run = (cmd, args, timeout = 30_000) => new Promise(resolve =>
  execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (e, out, err) => resolve({ ok: !e, out: String(out || '').trim(), err: String(err || '').trim() })));

// Session commands run here straight away instead of going through the agent (who used to read the command, reply
// and only then run session.sh). They still wait for any task in progress to finish before acting.
async function command(cmd) {
  const [name, arg = ''] = cmd.trim().split(/\s+/, 2);
  const busy = activity.state === 'working' ? ' once the current task finishes' : '';
  const session = async (args, text) => {
    const r = await run(path.join(BIN, 'session.sh'), args);
    return addMessage({ from: 'system', text: r.ok && !/^ERROR/.test(r.out) ? text : `Could not do that: ${r.out || r.err || 'unknown error'}` });
  };
  switch (name) {
    case 'new': return session(['new'], `Starting a fresh session${busy}. Memory and notes are kept.`);
    case 'compact': return session(['compact'], `Compacting this session${busy}. Takes about a minute.`);
    case 'restart': return session(['restart'], `Restarting the browsers and ${AGENT}${busy}. Back in about a minute.`);
    case 'resume':
      if (!/^\d+$/.test(arg)) return command('sessions');
      return session(['resume', arg], `Switching to session ${arg}${busy}. Back in about 30 seconds.`);
    case 'pending': {
      const lines = fs.readFileSync(path.join(AGENT_HOME, 'memory', 'pending.md'), 'utf8').split('\n').filter(l => l.startsWith('- '));
      return addMessage({ from: 'system', text: lines.length ? `**Waiting on you** (${lines.length})\n\n` +
        lines.map((l, i) => `${i + 1}. ${l.slice(2).replace(/^\d{4}-\d\d-\d\d \d\d:\d\d — /, '')}`).join('\n') : 'Nothing pending.' });
    }
    case 'info': case 'usage': {
      const r = await run(path.join(BIN, 'session.sh'), [cmd]);
      return addMessage({ from: 'system', text: '```\n' + (r.out || 'Could not read that right now.') + '\n```' });
    }
    case 'model':
      if (arg) return /^(opus|sonnet|haiku|default)$/.test(arg)
        ? session(['model', arg], `Switching the model to ${arg}${busy}.`) : addMessage({ from: 'system', text: `Unknown model: ${arg}` });
      return addMessage({ from: 'system', text: `**Model** — now using ${activity.usage?.model || 'unknown'}. Pick one:` + '\n- **opus**: strongest, for big tasks\n- **sonnet**: faster, great for quick questions\n- **haiku**: fastest, simple lookups',
        buttons: ['/model opus', '/model sonnet', '/model haiku', '/model default'] });
    case 'sessions': {
      const r = await run(path.join(BIN, 'session.sh'), ['list', '6']);
      const rows = [...r.out.matchAll(/^(\d+)\. (.+?) → (.+?) · (\d+) msgs · (.*)$/gm)];
      if (!rows.length) return addMessage({ from: 'system', text: 'No earlier sessions found.' });
      return addMessage({ from: 'system', text: '**Recent sessions** (tap one to go back to it)\n\n' +
        rows.map(x => `${x[1]}. ${x[2]} → ${x[3]} · ${x[4]} msgs · ${x[5]}`).join('\n'),
        buttons: rows.filter(x => !x[5].endsWith('(current)')).map(x => `/resume ${x[1]} · ${x[5].slice(0, 24)}`) });
    }
    default: return null;
  }
}

// ---------- Today panel: pending items, scheduled jobs (last run from bin/run-task.sh logs), usage ----------
const LOGS = path.join(AGENT_HOME, 'logs');
function nextRun(min, hour, dow) {   // only the "M H * * DOW" shapes the agent's jobs use
  const days = dow === '*' ? null : dow.replace(/1-5/, '1,2,3,4,5').split(',').map(d => ({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }[d] ?? Number(d) % 7));
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(+hour, +min, 0, 0);
    if (d > now && (!days || days.includes(d.getDay()))) {
      const hm = d.toTimeString().slice(0, 5);
      return { at: +d, label: i === 0 ? `today ${hm}` : i === 1 ? `tomorrow ${hm}` : `${d.toLocaleDateString('en-IN', { weekday: 'short' })} ${hm}` };
    }
  }
  return null;
}
async function today() {
  let pending = [];
  try {
    pending = fs.readFileSync(path.join(AGENT_HOME, 'memory', 'pending.md'), 'utf8').split('\n').filter(l => l.startsWith('- ')).map(l => {
      const t = l.slice(2).replace(/^\d{4}-\d\d-\d\d \d\d:\d\d — /, ''), m = t.match(/^\[([\w-]+)\]\s*(.*)$/s);
      const body = m ? m[2] : t;
      return { tag: m ? m[1] : '', text: body.length > 300 ? body.slice(0, 297).trimEnd() + '…' : body };
    });
  } catch {}
  const cron = (await run('crontab', ['-l'])).out.split('\n');
  const logs = fs.readdirSync(LOGS).filter(f => f.startsWith('job-')).sort().reverse();
  const jobs = cron.map(l => l.match(/^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s.*# agent-job:([\w-]+)\s*\|\s*(.*)$/)).filter(Boolean).map(([, min, hour, dow, name, when]) => {
    let title = name;
    try { title = fs.readFileSync(path.join(AGENT_HOME, 'schedules', `${name}.txt`), 'utf8').split(/[(.\n]/)[0].trim().slice(0, 44) || name; } catch {}
    const f = logs.find(x => x.startsWith(`job-${name}-2`));
    let last = null;
    if (f) {
      const txt = fs.readFileSync(path.join(LOGS, f), 'utf8'), [, d, hm] = f.match(/(\d{4}-\d\d-\d\d)_(\d{4})/) || [];
      const out = (txt.split('--- stdout ---')[1] || '').split('--- stderr ---')[0];
      const exit = Number((txt.match(/^exit: (\d+)/m) || [])[1] ?? 1), timedOut = /^timedOut: true/m.test(txt);
      const day = d === new Date().toLocaleDateString('en-CA') ? 'Today' : new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      last = { at: `${day} ${hm.slice(0, 2)}:${hm.slice(2)}`, ok: exit === 0 && !timedOut, timedOut,
        summary: out.split('\n').map(s => s.replace(/[*_`#>|]/g, '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim()).find(s => s.length > 3)?.slice(0, 180) || '' };
    }
    const next = nextRun(min, hour, dow);
    return { name, title, when, next: next?.label || '', nextAt: next?.at || Infinity, last };
  }).sort((a, b) => a.nextAt - b.nextAt);   // soonest first
  return { pending, jobs, usage: activity.usage || null, model: activity.usage?.model || '' };
}

// ---------- ask again with Opus: switch model, resend the question, switch back once answered ----------
let opusRetry = null;   // { prev, at } while a retry is running
async function retryWithOpus(id) {
  const ans = byId(id);
  if (!ans || ans.from !== 'agent') return { ok: false, error: `Can only retry ${AGENT}’s answers` };
  if (opusRetry && Date.now() - opusRetry.at < 15 * 60_000) return { ok: false, error: 'A retry is already running' };
  const q = messages.filter(m => m.from === 'me' && m.session === ans.session && m.ts < ans.ts).at(-1);
  if (!q || !(q.text || q.transcript)) return { ok: false, error: 'Could not find the question for that answer' };
  const saved = ((await run(path.join(BIN, 'session.sh'), ['model'])).out.match(/Saved default: (\S+)/) || [])[1] || 'default';
  const prev = /^(opus|sonnet|haiku)$/.test(saved) ? saved : 'default';
  const text = '(Asked again with Opus: give a more careful, thorough answer than before.)\n' + (q.text || q.transcript);
  const sendIt = () => { const m = addMessage({ from: 'me', text, files: q.files || [], status: 'queued' }); bridgeSend(m); };
  if (prev === 'opus') { sendIt(); return { ok: true }; }
  opusRetry = { prev, at: Date.now() };
  addMessage({ from: 'system', text: `Asking again with Opus. ${AGENT} switches back to ${prev} after the answer.` });
  const logFile = path.join(LOGS, 'session.log'), size0 = fs.statSync(logFile).size;
  await run(path.join(BIN, 'session.sh'), ['model', 'opus']);
  // session.sh types /model opus once the agent is idle; send the question only after that happened.
  const t0 = Date.now();
  const wait = setInterval(() => {
    let typed = false;
    try { const fd = fs.openSync(logFile, 'r'), n = fs.statSync(logFile).size - size0, buf = Buffer.alloc(Math.max(0, n)); fs.readSync(fd, buf, 0, n, size0); fs.closeSync(fd); typed = buf.toString().includes('model: typed /model opus'); } catch {}
    if (typed) { clearInterval(wait); setTimeout(() => { sendIt(); opusRetry.sent = Date.now(); }, 2500); }
    else if (Date.now() - t0 > 11 * 60_000) { clearInterval(wait); opusRetry = null; addMessage({ from: 'system', text: 'Could not switch to Opus (the agent stayed busy). Nothing was resent.' }); }
  }, 1000);
  return { ok: true };
}
function finishOpusRetry() {   // called when the agent goes idle
  if (!opusRetry?.sent || Date.now() - opusRetry.sent < 5000) return;
  const prev = opusRetry.prev; opusRetry = null;
  run(path.join(BIN, 'session.sh'), ['model', prev]).then(() => log('opus retry done, model back to', prev));
}

async function transcribe(m) {
  const f = m.files[0];
  const r = await run(path.join(HOME, '.local/bin/transcribe'), [f.path], 120_000);
  m.transcribing = false;
  if (r.ok && r.out) m.transcript = r.out; else { m.transcript_error = true; log('transcribe failed:', r.err.slice(0, 200)); }
  updateMessage(m);
  bridgeSend(m);
}

// ---------- HTTP ----------
function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = async req => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };
function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8' };

function serveFile(res, file, req) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);   // iOS audio/video need ranges
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes',
    'Cache-Control': file.startsWith(PUBLIC) ? 'no-cache' : 'private, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

async function handleBridge(req, res, url) {
  if (!sameSecret(req.headers['x-bridge'], conf.bridge)) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'GET' && url.pathname === '/bridge/events') {
    if (bridge) bridge.res.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const me = { res, id: rid(4) }; bridge = me;
    log('bridge connected'); bridgeState();
    res.write(': hi\n\n');
    flushQueue();
    req.on('close', () => { if (bridge === me) { bridge = null; log('bridge disconnected'); bridgeState(); } });
    return;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = await json(req);
  switch (url.pathname) {
    case '/bridge/ack': {
      const m = byId(b.id);
      if (m && m.status === 'queued') { m.status = 'delivered'; updateMessage(m); }
      return send(res, 200, { ok: true });
    }
    case '/bridge/reply': case '/local/post': {
      const files = [];
      for (const f of b.files || []) {
        try { files.push(mediaFile(String(f))); } catch (e) { return send(res, 400, { error: `file: ${e.message}` }); }
      }
      const buttons = (b.buttons || []).map(String).filter(Boolean).slice(0, 12);
      if (!b.system) markRead();
      const m = addMessage({ from: b.system ? 'system' : 'agent', text: String(b.text || ''), files,
        ...(buttons.length ? { buttons } : {}), ...(b.reply_to && byId(b.reply_to) ? { reply_to: b.reply_to } : {}) });
      // Alerts (bin/notify.sh) wait for the push result, so the script can fall back to Telegram.
      if (b.alert) return send(res, 200, { ok: true, id: m.id, delivered: await notify(m) });
      notify(m);
      return send(res, 200, { ok: true, id: m.id });
    }
    case '/bridge/react': {
      const m = byId(b.message_id);
      if (!m) return send(res, 404, { error: 'no such message' });
      m.reactions = b.emoji ? { [b.emoji]: true } : {};
      updateMessage(m); markRead();
      return send(res, 200, { ok: true });
    }
    case '/bridge/edit': {
      const m = byId(b.message_id);
      if (!m || m.from === 'me') return send(res, 404, { error: 'no such message of yours' });
      m.text = String(b.text || ''); m.edited = Date.now();
      updateMessage(m);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const cid = url.searchParams.get('cid') || rid(4);
    clients.set(cid, { res, visible: url.searchParams.get('visible') !== '0' });
    res.write(`event: state\ndata: ${JSON.stringify(stateMsg())}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => { clearInterval(ping); if (clients.get(cid)?.res === res) clients.delete(cid); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const before = url.searchParams.get('before'), limit = Math.min(Number(url.searchParams.get('limit')) || 60, 200);
    const sid = url.searchParams.get('session') || currentSession();
    const all = messages.filter(m => (m.session || '') === sid).map(publicMsg).concat(sessionItems(sid)).sort((a, b) => a.ts - b.ts);
    let end = all.length;
    if (before) { const i = all.findIndex(m => m.id === before); if (i >= 0) end = i; }
    return send(res, 200, { session: sid, current: currentSession(), messages: all.slice(Math.max(0, end - limit), end), more: end - limit > 0 });
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const window = Number(readJson(path.join(STATE, 'statusline.json'), {}).context_window?.context_window_size) || 1_000_000;
    const hidden = new Set(readJson(HIDDEN_FILE, { ids: [] }).ids), all = sessionList();
    const sessions = all.filter(s => !hidden.has(s.id)).slice(0, 80)
      .concat(all.filter(s => hidden.has(s.id)).map(s => ({ ...s, hidden: true }))).sort((a, b) => b.end - a.end);
    return send(res, 200, { current: currentSession(), window, sessions });
  }
  if (req.method === 'GET' && url.pathname === '/api/today') return send(res, 200, await today());
  if (req.method === 'GET' && url.pathname === '/api/suggestions') {   // quick buttons on an empty chat
    const own = readJson(path.join(AGENT_HOME, 'memory', 'app-suggestions.json'), {});   // kept up to date by the agent
    const fresh = Date.now() - Date.parse(own.updated || 0) < 3 * 86400_000 ? (own.items || []) : [];
    let pending = 0; try { pending = fs.readFileSync(path.join(AGENT_HOME, 'memory', 'pending.md'), 'utf8').split('\n').filter(l => l.startsWith('- ')).length; } catch {}
    const list = [...fresh.map(String).filter(Boolean).slice(0, 3), ...(pending ? ['What’s pending on me?'] : []),
      'What can you do for me?', 'Open google.com and send me a screenshot'];
    return send(res, 200, { items: [...new Set(list.map(x => x.trim().slice(0, 60)))].slice(0, 4) });
  }
  if (req.method === 'GET' && url.pathname === '/api/prefs') return send(res, 200, readJson(PREFS_FILE, {}));
  if (req.method === 'GET' && url.pathname === '/api/avatar') {
    const a = readJson(PREFS_FILE, {}).avatar;
    return serveFile(res, a ? path.join(APP_STATE, path.basename(a)) : path.join(PUBLIC, 'icons', 'avatar.png'), req);
  }
  if (req.method === 'POST' && url.pathname === '/api/prefs/avatar') {   // body: square JPEG made by the app; empty = reset
    const buf = await readBody(req, 5 * 1024 * 1024);
    if (buf.length && (buf[0] !== 0xff || buf[1] !== 0xd8)) return send(res, 400, { error: 'expected a JPEG' });
    const prefs = readJson(PREFS_FILE, {});
    if (prefs.avatar) fs.rmSync(path.join(APP_STATE, path.basename(prefs.avatar)), { force: true });
    if (buf.length) {
      prefs.avatar = `avatar-${rid(4)}.jpg`;
      fs.writeFileSync(path.join(APP_STATE, prefs.avatar), buf, { mode: 0o600 });
    } else delete prefs.avatar;
    writeJson(PREFS_FILE, prefs); broadcast('prefs', prefs);
    return send(res, 200, prefs);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...stateMsg(), vapid: push.vapid.publicKey });

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const name = path.basename(decodeURIComponent(String(req.headers['x-filename'] || 'file'))).replace(/[^\w.\- ]/g, '_').slice(-120) || 'file';
    const buf = await readBody(req, MAX_UPLOAD);
    const file = path.join(INBOX, `${Date.now()}-${rid(3)}-${name}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const kind = req.headers['x-kind'] === 'voice' ? 'voice' : fileKind(name);
    const id = rid(6);
    uploads.set(id, { name, path: file, kind, size: buf.length, url: `/inbox/${encodeURIComponent(path.basename(file))}` });
    return send(res, 200, { id, name, kind, size: buf.length });
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const b = await json(req);
  switch (url.pathname) {
    case '/api/send': {
      const text = String(b.text || '').slice(0, 20_000);
      const files = (b.files || []).map(id => uploads.get(id)).filter(Boolean);
      if (!text.trim() && !files.length) return send(res, 400, { error: 'empty' });
      const m = addMessage({ from: 'me', text, files, status: 'queued', ...(b.reply_to ? { reply_to: b.reply_to } : {}) });
      for (const id of b.files || []) uploads.delete(id);
      if (/^\s*(STOP|\/stop)[!. ]*$/.test(text)) writeJson(STOP_FILE, { from: 'app-msg', at: Date.now() });
      if (b.chose && byId(b.chose)) { const src = byId(b.chose); src.chosen = text; updateMessage(src); }
      if (files[0]?.kind === 'voice') { m.transcribing = true; updateMessage(m); transcribe(m); }
      else bridgeSend(m);
      return send(res, 200, { ok: true, id: m.id });
    }
    case '/api/prefs': {
      const prefs = readJson(PREFS_FILE, {});
      for (const [k, opts] of Object.entries(PREF_CHOICES)) if (opts.includes(b[k])) prefs[k] = b[k];
      writeJson(PREFS_FILE, prefs); broadcast('prefs', prefs);
      return send(res, 200, prefs);
    }
    case '/api/retry': {
      const r = await retryWithOpus(String(b.id || ''));
      return r.ok ? send(res, 200, r) : send(res, 400, { error: r.error });
    }
    case '/api/command': {
      if (b.chose && byId(b.chose)?.buttons) { const src = byId(b.chose); src.chosen = src.buttons.find(x => x.toLowerCase().startsWith('/' + String(b.cmd).split(' · ')[0])) || src.buttons[0]; updateMessage(src); }
      const m = await command(String(b.cmd || ''));
      return m ? send(res, 200, { ok: true }) : send(res, 400, { error: 'unknown command' });
    }
    case '/api/sessions/hide': {   // { id, hidden }: only changes what the sidebar shows
      const id = String(b.id || '');
      if (!/^[0-9a-f-]{36}$/.test(id)) return send(res, 400, { error: 'no such session' });
      if (b.hidden && id === currentSession()) return send(res, 400, { error: 'The live session can’t be hidden' });
      const ids = new Set(readJson(HIDDEN_FILE, { ids: [] }).ids);
      if (b.hidden) ids.add(id); else ids.delete(id);
      writeJson(HIDDEN_FILE, { ids: [...ids] });
      return send(res, 200, { ok: true });
    }
    case '/api/sessions/resume': {
      const id = String(b.id || '');
      if (!/^[0-9a-f-]{36}$/.test(id) || !fs.existsSync(path.join(PROJ, `${id}.jsonl`))) return send(res, 400, { error: 'no such session' });
      if (id === currentSession()) return send(res, 200, { ok: true, already: true });
      const r = await run(path.join(BIN, 'session.sh'), ['resume', id]);
      if (!r.ok) return send(res, 500, { error: r.out || r.err || 'resume failed' });
      addMessage({ from: 'system', session: id, text: `Switching to this session. ${AGENT} will be back in about 30 seconds.` });
      log('resume requested', id);
      return send(res, 200, { ok: true });
    }
    case '/api/stop':
      writeJson(STOP_FILE, { from: 'app', at: Date.now() });
      log('STOP from the app');
      return send(res, 200, { ok: true });
    case '/api/presence': {
      const c = clients.get(String(b.cid)); if (c) c.visible = !!b.visible;
      return send(res, 200, { ok: true });
    }
    case '/api/push': {
      const sub = b.subscription;
      if (!sub?.endpoint) return send(res, 400, { error: 'no subscription' });
      push.subs = push.subs.filter(s => s.endpoint !== sub.endpoint).concat(sub).slice(-5);
      writeJson(PUSH_FILE, push); log('push subscription saved');
      return send(res, 200, { ok: true });
    }
    case '/api/push/test':
      await webPush.sendNotification(push.subs.at(-1), JSON.stringify({ title: AGENT, body: 'Notifications are on', tag: 'test' })).catch(e => log('test push failed', e.statusCode));
      return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}
const uploads = new Map();   // upload id -> file (until sent)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Bridge + local scripts: direct localhost only (never through tailscale serve).
    if (url.pathname.startsWith('/bridge/') || url.pathname === '/local/post') {
      if (req.headers['tailscale-user-login'] || req.headers['x-forwarded-for']) return send(res, 404, { error: 'not found' });
      return await handleBridge(req, res, url);
    }
    // Everything else: only through tailscale serve (tailnet identity header present).
    if (!req.headers['tailscale-user-login']) return send(res, 403, 'Open this app over Tailscale.', 'text/plain');

    if (LIVE_PATHS.has(url.pathname)) return relayLive(req, res, url);
    const token = req.headers['x-token'] || url.searchParams.get('t');
    const authed = sameSecret(token, conf.token);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!authed) return send(res, 403, PAGE_LOCKED, 'text/html; charset=utf-8');
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replaceAll('__TOKEN__', conf.token).replaceAll('__AGENT_NAME__', esc(AGENT)).replaceAll('__OWNER_NAME__', esc(OWNER));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      if (!authed) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, {
        name: AGENT, short_name: AGENT, start_url: `/?t=${conf.token}`, scope: '/', display: 'standalone',
        // No theme_color in Auto: iOS would paint the status bar with it; without it the page's theme-color meta (light/dark) is used.
        ...(() => { const t = readJson(PREFS_FILE, {}).theme, c = t === 'light' ? '#faf7f2' : '#0d0b09';
          return t === 'light' || t === 'dark' ? { background_color: c, theme_color: c } : { background_color: '#0d0b09' }; })(),
        icons: [192, 512].map(s => ({ src: `/icons/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any' })),
      }, 'application/manifest+json');
    }
    // Static app files (no secrets in them).
    if (req.method === 'GET' && /^\/(app\.js|app\.css|prefs\.js|extras\.js|sw\.js|vendor\/[\w.-]+|icons\/[\w.-]+)$/.test(url.pathname)) {
      return serveFile(res, path.join(PUBLIC, url.pathname), req);
    }
    if (!authed) return send(res, 403, { error: 'forbidden' });
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/(media|inbox)\/([^/]+)$/))) {
      const name = path.basename(decodeURIComponent(m[2]));
      const dir = m[1] === 'media' ? MEDIA : fs.existsSync(path.join(INBOX, name)) ? INBOX : OLD_INBOX;
      return serveFile(res, path.join(dir, name), req);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () => log(`app server on 127.0.0.1:${PORT}`));

const PAGE_LOCKED = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${AGENT}</title>
<body style="font:16px -apple-system,system-ui;padding:32px;background:#0d0b09;color:#eee"><h2>${AGENT}</h2>
<p>Open the app from your personal link (ask ${AGENT} on Telegram for your “app link”).</p></body>`;
