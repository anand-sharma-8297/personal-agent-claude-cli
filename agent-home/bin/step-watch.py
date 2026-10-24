#!/usr/bin/env python3
"""Live step feed for the agent on Telegram.

Follows the main Claude session's transcript and keeps ONE progress message per task updated in the owner's chat
(italic, collapsible quote). When the task ends (session goes idle) the progress message is deleted, so only the
real answer stays. Short tasks (< MIN_SECONDS) never get a progress message. Costs no model tokens.

Off switch: the file ~/.local/state/personal-agent/watch-off (bin/step-watch.sh off|on|status).
Labels never include file contents, tool output, or anything that looks like a secret.
"""
from __future__ import annotations

import html, json, os, re, secrets, subprocess, time, urllib.parse, urllib.request
from pathlib import Path

HOME = Path.home()
AGENT_HOME = HOME / "agent-home"
SESS_DIR = HOME / ".claude" / "sessions"
PROJ = HOME / ".claude" / "projects" / str(AGENT_HOME).replace("/", "-")
STATE = HOME / ".local" / "state" / "personal-agent"
OFF_FILE = STATE / "watch-off"
KB_FLAG = STATE / "keyboard-open"   # written by tg-buttons.sh while a button keyboard is showing
LOG = AGENT_HOME / "logs" / "step-watch.log"

MIN_SECONDS = 5      # don't show a progress message for tasks shorter than this
EDIT_EVERY = 2.5     # seconds between edits of the progress message
MAX_LINES = 8        # most recent steps shown
POLL = 0.7


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%S ") + msg + "\n")


def env_get(path: Path, key: str) -> str:
    try:
        for line in path.read_text().splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


TOKEN = env_get(HOME / ".claude/channels/telegram/.env", "TELEGRAM_BOT_TOKEN")
CHAT = env_get(HOME / ".agent.env", "TELEGRAM_CHAT_ID")


def tg(method: str, **params):
    data = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/{method}", data)
    try:
        return json.load(urllib.request.urlopen(req, timeout=15))
    except Exception as e:  # network blips, "message is not modified", etc.
        return {"ok": False, "error": str(e)}


def hide_keyboard():
    """Owner answered (typed or tapped): remove the tg-buttons keyboard via a silent message, then delete that message."""
    if not KB_FLAG.exists():
        return
    KB_FLAG.unlink(missing_ok=True)
    r = tg("sendMessage", chat_id=CHAT, text="⌨️", disable_notification="true",
           reply_markup=json.dumps({"remove_keyboard": True}))
    if r.get("ok"):
        tg("deleteMessage", chat_id=CHAT, message_id=r["result"]["message_id"])
    else:
        log(f"hide keyboard failed: {r.get('error') or r.get('description')}")


# ---------- session discovery ----------
def main_session() -> tuple[str, str] | None:
    """(sessionId, status) of the claude process started with --channels."""
    for f in SESS_DIR.glob("*.json"):
        try:
            pid = int(f.stem)
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
            if "--channels" not in cmd:
                continue
            d = json.loads(f.read_text())
            return d.get("sessionId", ""), d.get("status", "idle")
        except (ValueError, OSError, json.JSONDecodeError):
            continue
    return None


# ---------- step labels ----------
SECRET = re.compile(r"(gsk_[A-Za-z0-9]+|\d{8,10}:AA[\w-]+|(?i:bearer)\s+\S+|"
                    r"(?i:(token|secret|password|passwd|api[_-]?key|client_secret)\s*[=:]\s*)\S+)")


def clean(s: str, n: int = 70) -> str:
    s = SECRET.sub("‹hidden›", re.sub(r"\s+", " ", str(s or "")).strip())
    return s if len(s) <= n else s[: n - 1] + "…"


def short_path(p: str) -> str:
    p = str(p or "")
    for base, rep in ((str(AGENT_HOME) + "/", ""), (str(HOME) + "/", "~/")):
        if p.startswith(base):
            return rep + p[len(base):]
    return p


def short_url(u: str) -> str:
    m = re.match(r"https?://([^/?#]+)([^?#]*)", str(u or ""))
    return clean((m.group(1) + m.group(2)) if m else u, 60)


SKIP = {"ToolSearch", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"}


def label(name: str, inp: dict) -> str | None:
    if name in SKIP:
        return None
    if name == "Bash":
        return "🔧 " + clean(inp.get("description") or inp.get("command"))
    if name == "Read":
        return "📄 read " + clean(short_path(inp.get("file_path")), 60)
    if name in ("Edit", "Write", "NotebookEdit"):
        return "✏️ " + ("write " if name == "Write" else "edit ") + clean(short_path(inp.get("file_path")), 60)
    if name in ("Grep", "Glob"):
        return "🔎 search " + clean(inp.get("pattern"), 50)
    if name in ("WebSearch",):
        return "🌐 web search: " + clean(inp.get("query"), 55)
    if name in ("WebFetch",):
        return "🌐 fetch " + short_url(inp.get("url"))
    if name in ("Task", "Agent"):
        return "🤖 sub-task: " + clean(inp.get("description"), 55)
    if name.startswith("mcp__plugin_telegram"):
        act = name.rsplit("__", 1)[-1]
        return {"reply": "💬 sent you a message", "edit_message": "💬 updated a message",
                "download_attachment": "📎 downloaded your attachment", "react": None}.get(act, "💬 " + act)
    if name.startswith("mcp__app__"):
        act = name.rsplit("__", 1)[-1]
        return {"reply": "💬 sent you a message", "edit_message": "💬 updated a message", "react": None}.get(act, "💬 " + act)
    m = re.match(r"mcp__claude_ai_(\w+?)__(?:\w+?_)?(search|read|get|list|create|update|send|schedule|add|copy|download|apply|label|unlabel|mark|trash|untrash|complete|delete)(\w*)$", name)
    if m:   # claude.ai connectors: "🧩 Slack: search users"
        svc = re.sub(r"^Google ", "", m.group(1).replace("_", " "))
        return "🧩 " + clean(f"{svc}: {m.group(2)}{m.group(3).replace('_', ' ')}", 50)
    m = re.match(r"mcp__browser_(personal|work)__browser_(\w+)", name)
    if m:
        who, act = m.groups()
        b = "🌐 " + who + " browser"
        if act == "navigate":
            return f"{b} → {short_url(inp.get('url'))}"
        if act == "tabs":
            a = inp.get("action") or "list"
            return f"{b}: {a} tab" + (f" {short_url(inp.get('url'))}" if inp.get("url") else "")
        if act == "click":
            return f"{b}: click {clean(inp.get('element'), 40)}"
        if act in ("type", "fill_form"):
            return f"{b}: typing into {clean(inp.get('element') or 'a field', 35)}"
        if act == "take_screenshot":
            return f"{b}: screenshot"
        if act == "snapshot":
            return f"{b}: reading page"
        if act == "wait_for":
            return f"{b}: waiting for page"
        if act == "file_upload":
            return f"{b}: uploading file"
        if act == "run_code_unsafe":
            return f"{b}: running page script"
        return f"{b}: {act.replace('_', ' ')}"
    if name.startswith("mcp__"):
        parts = name.split("__")
        return "🧩 " + clean(" ".join(parts[1:]).replace("_", " "), 50)
    return "• " + name


# ---------- live-view links ----------
# Pinned live-view links: one lasting token per browser in live-pin.json (read by login-helper.mjs), renewed every
# PIN_DAYS days. They sit as buttons on the pinned status message. Login links (bin/login-link.sh) are separate, so
# these never cancel them.
LIVE_PIN = STATE / "live-pin.json"
PIN_DAYS = 30
LOGIN_HELPER_PORT = 8932
_ts_ip = ""


def tailscale_ip() -> str:
    global _ts_ip
    if not _ts_ip:
        try:
            out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=10).stdout.split()
            _ts_ip = out[0] if out else ""
        except (OSError, subprocess.SubprocessError):
            pass
    return _ts_ip


def pin_links() -> dict[str, str]:
    """{browser: live-view URL}, renewing the tokens when they have less than a day left."""
    try:
        pin = json.loads(LIVE_PIN.read_text())
    except (OSError, json.JSONDecodeError):
        pin = {}
    if float(pin.get("expires", 0)) / 1000 - time.time() < 86400 or set(pin.get("tokens", {})) != {"personal", "work"}:
        pin = {"tokens": {b: secrets.token_hex(24) for b in ("personal", "work")},
               "expires": int((time.time() + PIN_DAYS * 86400) * 1000)}
        tmp = LIVE_PIN.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(pin, f)
        tmp.replace(LIVE_PIN)
        log("live-view pinned links renewed")
    ip = tailscale_ip()
    return {b: f"http://{ip}:{LOGIN_HELPER_PORT}/?t={t}" for b, t in pin["tokens"].items()} if ip else {}


# ---------- activity.json: what the agent is doing now + the last few tasks (the app shows it live) ----------
ACTIVITY = STATE / "activity.json"
HISTORY = 10          # finished tasks kept
ACT_STEPS = 60        # most recent steps kept per task


def write_private(path: Path, data: dict):
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    tmp.replace(path)


def line_time(d: dict) -> float:
    """When a transcript line really happened (its own timestamp); now if missing. The transcript is sometimes
    written in one burst at the end of a quick task, so the watcher's clock would put every step after the answer."""
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(d["timestamp"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, TypeError):
        return time.time()


def channel_text(c) -> str:
    """The owner's message text from a <channel …>text</channel> transcript line (secrets hidden)."""
    s = c if isinstance(c, str) else " ".join(b.get("text", "") for b in (c or []) if isinstance(b, dict))
    m = re.search(r"<channel [^>]*>(.*?)</channel>", s, re.S)
    return clean(m.group(1), 160) if m else ""


class Activity:
    def __init__(self):
        try:
            self.history = json.loads(ACTIVITY.read_text()).get("history", [])[:HISTORY]
        except (OSError, json.JSONDecodeError, AttributeError):
            self.history = []
        self.key = None; self.last = 0.0

    def done(self, turn: "Turn"):
        if turn.steps or turn.text:
            self.history.insert(0, turn.summary(done=True)); del self.history[HISTORY:]
        self.key = None

    def write(self, session: tuple[str, str] | None, turn: "Turn | None"):
        state = "offline" if not session else ("working" if turn or session[1] != "idle" else "idle")
        key = (state, id(turn), len(turn.steps) if turn else 0, turn.text if turn else "")
        if key == self.key and time.time() - self.last < 10:
            return
        try:
            u = json.loads(USAGE_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            u = {}
        rl, now = u.get("rate_limits") or {}, time.time()
        write_private(ACTIVITY, {
            "updated": now, "state": state, "task": turn.summary() if turn else None, "history": self.history,
            "usage": {"model": str(u.get("model") or "?"), "five_hour": StatusPin.window(rl.get("five_hour"), now),
                      "week": StatusPin.window(rl.get("seven_day"), now)}})
        self.key, self.last = key, now


# ---------- big-context reminder ----------
# After each finished task, if the agent's context is at or above CONTEXT_WARN tokens (or half the context window,
# whichever is smaller), send a short line suggesting /new. The size comes from statusline.json (written by
# bin/statusline.sh after every reply).
STATUSLINE = STATE / "statusline.json"
CONTEXT_WARN = 500_000


def context_tokens(sid: str) -> tuple[int, int] | None:
    """(tokens in context, window size) for session sid, or None if unknown."""
    try:
        d = json.loads(STATUSLINE.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if d.get("session_id") != sid:
        return None
    cw = d.get("context_window") or {}
    u = cw.get("current_usage") or {}
    used = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return used, int(cw.get("context_window_size") or 0)


def context_reminder(turn: "Turn", sid: str):
    ctx = context_tokens(sid)
    if not ctx:
        return
    used, size = ctx
    if used < (min(CONTEXT_WARN, size // 2) if size else CONTEXT_WARN):
        return
    text = (f"🧠 Context is {used // 1000}K" + (f" of {size // 1000}K" if size else "") +
            ". Send /new for a fresh session (memory and notes are kept).")
    if turn.channel == "app":
        ok = subprocess.run([str(AGENT_HOME / "bin/app-send.sh"), "--system", text], capture_output=True, timeout=20).returncode == 0
    else:
        ok = tg("sendMessage", chat_id=CHAT, text=text, disable_notification="true").get("ok")
    log(f"context reminder ({used // 1000}K, {turn.channel}): {'sent' if ok else 'send failed'}")


# ---------- progress message ----------
class Turn:
    def __init__(self, channel: str = "telegram"):
        self.channel = channel            # where the task came from: "telegram" or "app"
        self.start = time.time()
        self.steps: list[str] = []
        self.times: list[float] = []      # when each step started (activity.json)
        self.text = ""                    # the owner's message (activity.json)
        self.t0 = 0.0                     # when the owner's message really arrived (transcript time)
        self.msg_id: int | None = None
        self.last_edit = 0.0
        self.last_text = ""
        self.dirty = False

    def render(self) -> str:
        secs = int(time.time() - self.start)
        head = f"⚙️ Working · {secs // 60}:{secs % 60:02d}"
        shown = self.steps[-MAX_LINES:]
        more = len(self.steps) - len(shown)
        lines = ([f"… {more} earlier step(s)"] if more else []) + [f"› {s}" for s in shown]
        body = html.escape("\n".join([head] + lines))
        return f"<blockquote expandable><i>{body}</i></blockquote>"

    def summary(self, done: bool = False) -> dict:
        n = len(self.steps)
        return {"channel": self.channel, "text": self.text, "start": self.t0 or self.start,
                **({"secs": int(time.time() - self.start)} if done else {}), "count": n,
                "steps": [{"t": t, "s": s} for t, s in zip(self.times[-ACT_STEPS:], self.steps[-ACT_STEPS:])]}

    def push(self, force: bool = False):
        if self.channel == "app":   # the app shows activity.json itself
            return
        if not self.steps or time.time() - self.start < MIN_SECONDS:
            return
        if not force and time.time() - self.last_edit < EDIT_EVERY:
            return
        text = self.render()
        if text == self.last_text:
            return
        if self.msg_id is None:
            r = tg("sendMessage", chat_id=CHAT, text=text, parse_mode="HTML", disable_notification="true")
            if r.get("ok"):
                self.msg_id = r["result"]["message_id"]
        else:
            tg("editMessageText", chat_id=CHAT, message_id=self.msg_id, text=text, parse_mode="HTML")
        self.last_text, self.last_edit = text, time.time()

    def finish(self):
        if self.msg_id is not None and self.channel == "telegram":
            tg("deleteMessage", chat_id=CHAT, message_id=self.msg_id)
        log(f"turn done: {len(self.steps)} steps, {int(time.time() - self.start)}s, msg={self.msg_id}")


# ---------- pinned status + limit warnings ----------
# One pinned message at the top of the Telegram chat: agent state + Claude plan usage, edited in place when it
# changes. Usage comes from usage.json, written by bin/statusline.sh on every Claude Code status-line refresh.
# Also warns once per limit window when the 5-hour or weekly usage passes WARN_AT.
USAGE_FILE = STATE / "usage.json"
PIN_FILE = STATE / "status-pin.json"
PIN_EVERY = 20                 # seconds between checks (an edit only happens when the text changes)
WARN_AT = ()                   # limit warnings off (the pinned bar shows usage); e.g. (80, 95) to turn them on


class StatusPin:
    def __init__(self):
        try:
            st = json.loads(PIN_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            st = {}
        self.msg_id = st.get("msg_id"); self.warned = st.get("warned", {})
        self.text = None; self.markup = None; self.state = None; self.last = 0.0

    def save(self):
        PIN_FILE.write_text(json.dumps({"msg_id": self.msg_id, "warned": self.warned}))

    @staticmethod
    def window(r: dict | None, now: float) -> tuple[str, str]:
        """(percent text, reset clock) for one rate-limit window."""
        if not r or r.get("resets_at") is None:
            return "?", ""
        if r["resets_at"] <= now:
            return "0%", "reset ✓"
        t = time.localtime(r["resets_at"])
        same_day = time.strftime("%Y%m%d", t) == time.strftime("%Y%m%d")
        return f"{round(r.get('used_percentage', 0))}%", time.strftime("%H:%M" if same_day else "%a %H:%M", t)

    def tick(self, session: tuple[str, str] | None):
        state = "🔴 Offline" if not session else ("🟢 Idle" if session[1] == "idle" else "🟡 Working")
        if state == self.state and time.time() - self.last < PIN_EVERY:
            return
        self.state, self.last, now = state, time.time(), time.time()
        try:
            u = json.loads(USAGE_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            u = {}
        rl = u.get("rate_limits") or {}
        h5, h5r = self.window(rl.get("five_hour"), now)
        wk, wkr = self.window(rl.get("seven_day"), now)
        model = str(u.get("model") or "?").split(" ")[0]          # "Opus 5.5" → "Opus" so the pinned bar fits one line
        text = f"{state} · {model} · 5h {h5} · Wk {wk}"   # one line only; reset times: /usage
        links = pin_links()
        markup = json.dumps({"inline_keyboard": [[{"text": f"🖥️ {b.capitalize()}", "url": links[b]}
                                                   for b in ("personal", "work") if b in links]]})
        if (text, markup) != (self.text, self.markup):
            self.show(text, markup)
        self.warn(rl, now)

    def show(self, text: str, markup: str):
        if self.msg_id:
            r = tg("editMessageText", chat_id=CHAT, message_id=self.msg_id, text=f"<i>{html.escape(text)}</i>", parse_mode="HTML",
                   reply_markup=markup)
            if r.get("ok") or "not modified" in str(r):
                self.text, self.markup = text, markup; return
            if "not found" not in str(r) and "can't be edited" not in str(r):
                return                          # network blip: retry on the next tick
        r = tg("sendMessage", chat_id=CHAT, text=f"<i>{html.escape(text)}</i>", parse_mode="HTML", disable_notification="true",
               reply_markup=markup)
        if r.get("ok"):
            self.msg_id = r["result"]["message_id"]; self.text, self.markup = text, markup; self.save()
            tg("pinChatMessage", chat_id=CHAT, message_id=self.msg_id, disable_notification="true")
            log(f"status pin: new message {self.msg_id}")

    def warn(self, rl: dict, now: float):
        for key, name in (("five_hour", "5-hour"), ("seven_day", "Weekly")):
            r = rl.get(key) or {}
            pct, reset = r.get("used_percentage"), r.get("resets_at")
            if pct is None or reset is None or reset <= now:
                continue
            level = max([w for w in WARN_AT if pct >= w], default=0)
            k = f"{key}:{reset}"
            if level and self.warned.get(k, 0) < level:
                when = time.strftime("%a %d %b %H:%M", time.localtime(reset))
                tip = "\nTip: /model sonnet for everyday tasks stretches the limit." if key == "seven_day" else ""
                r2 = tg("sendMessage", chat_id=CHAT, text=f"⚠️ {name} Claude limit {round(pct)}% used — resets {when}.{tip}")
                if r2.get("ok"):
                    self.warned = {kk: v for kk, v in self.warned.items() if kk.split(":")[1] and float(kk.split(":")[1]) > now}
                    self.warned[k] = level; self.save()
                    log(f"limit warning: {key} {pct}%")


def main():
    if not (TOKEN and CHAT):
        log("missing bot token or TELEGRAM_CHAT_ID; exiting")
        return
    log("step watcher started")
    pin = StatusPin()
    act = Activity()
    sid = None; fh = None; turn: Turn | None = None; idle_since = None
    while True:
        time.sleep(POLL)
        s = main_session()
        try:
            pin.tick(s)
        except Exception as e:   # never let the status pin break the step feed
            log(f"status pin error: {e}")
        try:
            act.write(s, turn)
        except Exception as e:   # never let the activity file break the step feed
            log(f"activity error: {e}")
        if not s:
            continue
        cur_sid, status = s
        if cur_sid != sid:                      # new session (/new, restart, resume): follow the new transcript
            if turn:
                turn.finish(); act.done(turn); turn = None
            sid = cur_sid
            path = PROJ / f"{sid}.jsonl"
            if fh:
                fh.close()
            fh = None
            for _ in range(20):
                if path.exists():
                    fh = path.open("r", encoding="utf-8"); fh.seek(0, os.SEEK_END); break
                time.sleep(0.5)
            continue
        if fh is None:
            path = PROJ / f"{sid}.jsonl"
            if path.exists():
                fh = path.open("r", encoding="utf-8"); fh.seek(0, os.SEEK_END)
            continue

        enabled = not OFF_FILE.exists()
        for line in fh.readlines():
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            c = d.get("message", {}).get("content")
            src = re.search(r'<channel source=\\?"([^"\\]+)', line) if d.get("type") == "user" else None
            if src and src.group(1) == "app":
                if turn is None:
                    turn = Turn("app")
                turn.text = turn.text or channel_text(c)
                turn.t0 = turn.t0 or line_time(d)
            elif src and "telegram" in src.group(1):
                if turn is None:
                    turn = Turn()
                turn.text = turn.text or channel_text(c)
                turn.t0 = turn.t0 or line_time(d)
                hide_keyboard()
                # Instant "seen" signal: 👀 on the owner's message as soon as the agent has received it.
                for mid in re.findall(r'message_id=\\?"(\d+)', line):
                    r = tg("setMessageReaction", chat_id=CHAT, message_id=mid,
                           reaction=json.dumps([{"type": "emoji", "emoji": "👀"}]))
                    if not r.get("ok"):
                        log(f"seen reaction failed for {mid}: {r.get('error') or r.get('description')}")
            elif d.get("type") == "assistant" and isinstance(c, list) and turn is not None:
                for b in c:
                    if b.get("type") == "tool_use":
                        lab = label(b.get("name", ""), b.get("input") or {})
                        if lab:
                            turn.steps.append(lab); turn.times.append(line_time(d)); turn.dirty = True

        if turn is None:
            continue
        if status == "idle" and time.time() - turn.start > 4:   # ignore the brief idle right after a message lands
            idle_since = idle_since or time.time()
            if time.time() - idle_since >= 1.5:   # idle for a moment = task finished
                turn.finish(); act.done(turn)
                try:
                    context_reminder(turn, sid)
                except Exception as e:   # never let the reminder break the step feed
                    log(f"context reminder error: {e}")
                turn = None; idle_since = None
            continue
        idle_since = None
        if enabled:
            turn.push()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
