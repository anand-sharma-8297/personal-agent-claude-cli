#!/usr/bin/env node
// agent app channel (Claude Code channel MCP server): connects the main Claude session to the app server
// (app/server.mjs, 127.0.0.1:8950). The app server keeps history and queues; this bridge only passes messages.
// - Inbound: only when APP_LISTEN=1 (set by bin/start-claude.sh for the main session) it subscribes to
//   /bridge/events and turns each owner message into a channel notification, then acks it.
// - Outbound tools: reply / react / edit_message.
// Bridge secret: ~/.local/state/personal-agent/app/app.json (read here, never shown to Claude).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HOME = os.homedir();
const BASE = `http://127.0.0.1:${process.env.APP_PORT || 8950}`;
const CONF = path.join(HOME, '.local/state/personal-agent/app/app.json');
const LOG_FILE = path.join(HOME, 'agent-home/logs/app-channel.log');
const LISTEN = process.env.APP_LISTEN === '1';

const log = (...a) => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };
const secret = () => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')).bridge; } catch { return ''; } };

async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge': secret() }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `app server HTTP ${res.status}`);
  return j;
}

const mcp = new Server(
  { name: 'app', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The owner reads the agent app (their own chat app on the phone), not this session. Anything they should see must go through the app reply tool. Reply on the channel the message came from.',
      '',
      'Messages arrive as <channel source="app" chat_id="app" message_id="..." ts="...">. image_path = a photo they sent (Read it). attachment_path = a file they sent (already on disk; attachment_kind voice/audio/video/file). Voice notes arrive already transcribed: "(voice note, transcribed) <text>" — the app shows the transcript, so no 🎙️ line is needed. reply_to_id = they replied to that message.',
      '',
      'reply: full Markdown works (headings, **bold**, tables, code blocks, [links](url)). files: absolute paths (images and video show inline, others as downloads). buttons: up to 12 short choices shown as tap chips; the tap comes back as a normal message. The app shows your live steps and a timer by itself, so do NOT send "on it"/progress messages — just the answer. No 24 h limit, no length limit.',
    ].join('\n'),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the owner in the agent app. Markdown supported. Optional files (absolute paths), buttons (tap choices), reply_to (message_id to quote).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Always "app" (optional).' },
          text: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          buttons: { type: 'array', items: { type: 'string' }, description: 'Up to 12 short choices (≤ 40 chars).' },
          reply_to: { type: 'string' },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description: 'Put an emoji reaction on a message in the app (empty emoji removes it).',
      inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } }, required: ['message_id', 'emoji'] },
    },
    {
      name: 'edit_message',
      description: 'Replace the text of a message you sent earlier in the app.',
      inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, text: { type: 'string' } }, required: ['message_id', 'text'] },
    },
  ],
}));

const ok = text => ({ content: [{ type: 'text', text }] });
const fail = text => ({ content: [{ type: 'text', text }], isError: true });

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const a = req.params.arguments ?? {};
  try {
    switch (req.params.name) {
      case 'reply': {
        for (const f of a.files ?? []) if (!fs.existsSync(f)) return fail(`file not found: ${f}`);
        const r = await post('/bridge/reply', { text: a.text ?? '', files: a.files ?? [], buttons: a.buttons ?? [], reply_to: a.reply_to });
        return ok(`sent (message_id ${r.id})`);
      }
      case 'react': await post('/bridge/react', { message_id: a.message_id, emoji: a.emoji ?? '' }); return ok('reacted');
      case 'edit_message': await post('/bridge/edit', { message_id: a.message_id, text: a.text ?? '' }); return ok('edited');
      default: return fail(`unknown tool ${req.params.name}`);
    }
  } catch (e) {
    log('tool', req.params.name, 'failed:', e.message);
    return fail(`${e.message} — the app server may be down (tmux window agent:app); answer on Telegram instead.`);
  }
});

// ---------- inbound: SSE from the app server ----------
async function listen() {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    try {
      const res = await fetch(`${BASE}/bridge/events`, { headers: { 'X-Bridge': secret() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log('connected to app server'); wait = 1000;
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1];
          if (ev !== 'inbound' || !data) continue;
          const msg = JSON.parse(data);
          try {
            await mcp.notification({ method: 'notifications/claude/channel', params: msg });
            await post('/bridge/ack', { id: msg.meta.message_id });
            log('delivered', msg.meta.message_id);
          } catch (e) { log('deliver failed:', e.message); }
        }
      }
      log('app server stream ended');
    } catch (e) { log('app server unreachable:', e.message); }
    await new Promise(r => setTimeout(r, wait));
  }
}

await mcp.connect(new StdioServerTransport());
if (LISTEN) listen(); else log('APP_LISTEN not set — send-only mode');
