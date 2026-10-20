#!/usr/bin/env bash
# session.sh — the agent's Telegram slash-command backend (session control + status).
#   session.sh new                 clear context once idle (= /clear in the Claude window)
#   session.sh compact             summarise context once idle (= /compact)
#   session.sh list [N]            recent Telegram sessions, newest first (number them for resume)
#   session.sh resume <n|id>       restart Claude on that session (full context back)
#   session.sh model [name]        show / set the model (opus, sonnet, haiku, default, or a full model id)
#   session.sh info                health + session status
#   session.sh restart             full restart: browsers + Claude
# new/compact/resume/model/restart act a few seconds AFTER the current turn ends, so reply first, then call this
# as your last action. They run outside Claude's process tree (systemd-run), so a restart can't kill them.
set -uo pipefail
. "$(dirname "$0")/common.sh"

PANE="$TMUX_SESSION:claude"
PROJ="$HOME/.claude/projects/$(printf '%s' "$AGENT_HOME" | sed 's|/|-|g')"
RESUME_FILE="$STATE_DIR/resume-session"

cur_pid()    { main_claude_pids | head -n1; }
sess_json()  { local p; p="$(cur_pid)"; [[ -n "$p" ]] && cat "$HOME/.claude/sessions/$p.json" 2>/dev/null; }
cur_status() { sess_json | jq -r '.status // "idle"' 2>/dev/null || echo none; }
cur_id()     { sess_json | jq -r '.sessionId // empty' 2>/dev/null; }

# Run a command detached from Claude (survives restarts of the agent).
detach() {  # detach <name> <bash code>
    local env=(XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
               DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
               WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}")
    if command -v systemd-run >/dev/null && env "${env[@]}" systemd-run --user --quiet --collect \
            --unit "agent-$1-$(date +%s)" --setenv=XDG_RUNTIME_DIR="${env[0]#*=}" \
            --setenv=DBUS_SESSION_BUS_ADDRESS="${env[1]#*=}" --setenv=WAYLAND_DISPLAY="${env[2]#*=}" \
            bash -c "$2" 2>/dev/null; then
        return 0
    fi
    env "${env[@]}" setsid -f bash -c "$2" >/dev/null 2>&1 < /dev/null
}

# Bash snippet: wait (max 10 min) until the Claude session has been idle for ~4s.
WAIT_IDLE='. "'"$BIN_DIR"'/common.sh"
idle=0
for ((i = 0; i < 300; i++)); do
    p="$(main_claude_pids | head -n1)"
    s="$(jq -r ".status // \"idle\"" "$HOME/.claude/sessions/$p.json" 2>/dev/null)"
    if [[ "$s" == idle ]]; then idle=$((idle + 1)); (( idle >= 2 )) && break; else idle=0; fi
    sleep 2
done'

type_into_claude() {  # type_into_claude <name> <text>
    detach "$1" "$WAIT_IDLE
tmux send-keys -t '$PANE' C-u
tmux send-keys -t '$PANE' -l '$2'
sleep 0.5
tmux send-keys -t '$PANE' Enter
log session '$1: typed $2'
# Claude Code may ask to confirm (e.g. 'Switch model?' mid-conversation, option 1 = Yes is preselected).
# The owner already asked for this on Telegram, so accept it.
for ((k = 0; k < 8; k++)); do
    sleep 1
    if tmux capture-pane -p -t '$PANE' | grep -qE 'Switch model\\?|❯ 1\\. Yes'; then
        tmux send-keys -t '$PANE' Enter
        log session '$1: confirmed prompt'
        break
    fi
done"
}

list_sessions() {  # prints: n<TAB>id<TAB>start<TAB>end<TAB>msgs<TAB>first message
    PROJ="$PROJ" CUR="$(cur_id)" LIMIT="${1:-10}" python3 - <<'EOF'
import glob, json, os, re
from datetime import datetime
rows = []
for f in glob.glob(os.path.join(os.environ["PROJ"], "*.jsonl")):
    first = start = end = None; n = 0
    try:
        for line in open(f, encoding="utf-8"):
            if "<channel" not in line and '"timestamp"' not in line:
                continue
            try: d = json.loads(line)
            except ValueError: continue
            ts = d.get("timestamp")
            if ts:
                start = start or ts; end = ts
            if d.get("type") != "user": continue
            c = d.get("message", {}).get("content")
            texts = [c] if isinstance(c, str) else [b.get("text", "") for b in c or [] if isinstance(b, dict)]
            for t in texts:
                m = re.search(r"<channel[^>]*telegram[^>]*>(.*?)</channel>", t or "", re.S)
                if m:
                    n += 1
                    first = first or re.sub(r"\s+", " ", m.group(1)).strip()
    except OSError:
        continue
    if n:
        rows.append((end, os.path.basename(f)[:-6], start, n, first))
rows.sort(reverse=True)
fmt = lambda ts: datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%d %b %H:%M")
for i, (end, sid, start, n, first) in enumerate(rows[: int(os.environ["LIMIT"])], 1):
    cur = " (current)" if sid == os.environ["CUR"] else ""
    print(f"{i}\t{sid}\t{fmt(start)}\t{fmt(end)}\t{n}\t{first[:70]}{cur}")
EOF
}

cmd="${1:-info}"; shift || true
case "$cmd" in
  new)
    type_into_claude new "/clear"
    echo "OK: context will be cleared a few seconds after this turn ends (memory files are kept)." ;;

  compact)
    type_into_claude compact "/compact"
    echo "OK: the session will be compacted a few seconds after this turn ends." ;;

  list|sessions)
    list_sessions "${1:-10}" | awk -F'\t' '{printf "%s. %s → %s · %s msgs · %s\n   id %s\n", $1, $3, $4, $5, $6, $2}' ;;

  resume)
    want="${1:?usage: session.sh resume <number from list | session id>}"
    if [[ "$want" =~ ^[0-9]+$ ]]; then
        id="$(list_sessions 50 | awk -F'\t' -v n="$want" '$1 == n {print $2}')"
    else
        id="$want"
    fi
    [[ -n "$id" && -f "$PROJ/$id.jsonl" ]] || { echo "ERROR: no session '$want' (see: session.sh list)"; exit 1; }
    [[ "$id" == "$(cur_id)" ]] && { echo "That is already the current session."; exit 0; }
    mkdir -p "$STATE_DIR"; printf '%s\n' "$id" > "$RESUME_FILE"
    detach resume "$WAIT_IDLE
'$BIN_DIR/restart-claude.sh'"
    echo "OK: will restart on session $id about 20 s after this turn ends." ;;

  model)
    name="${1:-}"
    if [[ -z "$name" ]]; then
        cur="$(env_get "$ENV_FILE" AGENT_MODEL)"
        last="$(tac "$PROJ/$(cur_id).jsonl" 2>/dev/null | grep -m1 -o '"model":"[^"]*"' | cut -d'"' -f4)"
        echo "Saved default: ${cur:-account default} · in use now: ${last:-unknown}"
        echo "Options: opus, sonnet, haiku, default, or a full model id (e.g. claude-sonnet-5-5)."
        exit 0
    fi
    [[ "$name" =~ ^(opus|sonnet|haiku|default|claude-[a-z0-9.-]+)$ ]] || { echo "ERROR: unknown model '$name'"; exit 1; }
    touch "$ENV_FILE"
    if [[ "$name" == default ]]; then
        sed -i '/^AGENT_MODEL=/d' "$ENV_FILE"
    elif grep -q '^AGENT_MODEL=' "$ENV_FILE"; then
        sed -i "s|^AGENT_MODEL=.*|AGENT_MODEL=$name|" "$ENV_FILE"
    else
        printf 'AGENT_MODEL=%s\n' "$name" >> "$ENV_FILE"
    fi
    type_into_claude model "/model $name"
    echo "OK: model → $name (switches a few seconds after this turn; kept after restarts)." ;;

  sessions-menu)   # list + tap-to-resume buttons, sent straight to Telegram
    rows="$(list_sessions "${1:-6}")"
    [[ -n "$rows" ]] || { "$BIN_DIR/tg-buttons.sh" --hide "No earlier sessions found."; exit 0; }
    text="📋 Recent sessions:"$'\n'"$(awk -F'\t' '{printf "%s. %s → %s · %s msgs · %s\n", $1, $3, $4, $5, $6}' <<<"$rows")"$'\n\n'"Tap one to go back to it."
    mapfile -t btns < <(awk -F'\t' '$6 !~ /\(current\)$/ {t=$6; if (length(t) > 24) t=substr(t,1,24) "…"; printf "/resume %s · %s (%s)\n", $1, t, $3}' <<<"$rows")
    "$BIN_DIR/tg-buttons.sh" --cols 1 "$text" "${btns[@]}" "✖ Cancel" ;;

  model-menu)      # current model + tap-to-switch buttons
    cur="$(tac "$PROJ/$(cur_id).jsonl" 2>/dev/null | grep -m1 -o '"model":"[^"]*"' | cut -d'"' -f4)"
    "$BIN_DIR/tg-buttons.sh" --cols 2 "🧠 Model now: ${cur:-unknown}. Pick one:
• opus — strongest, best for big tasks
• sonnet — faster, cheaper, great for quick questions
• haiku — fastest, simple lookups
• default — back to the account default" \
      "/model opus" "/model sonnet" "/model haiku" "/model default" "✖ Cancel" ;;

  info|status)
    j="$(sess_json)"; id="$(cur_id)"; f="$PROJ/$id.jsonl"
    started="$(jq -r '.startedAt // 0' <<<"$j" 2>/dev/null)"
    age=$(( ($(date +%s%3N) - ${started:-0}) / 60000 ))
    turns="$(list_sessions 50 | awk -F'\t' -v id="$id" '$2 == id {print $5}')"
    ctx="$(tac "$f" 2>/dev/null | grep -m1 '"usage"' | jq -r '.message.usage | ((.input_tokens//0)+(.cache_read_input_tokens//0)+(.cache_creation_input_tokens//0))' 2>/dev/null)"
    model="$(tac "$f" 2>/dev/null | grep -m1 -o '"model":"[^"]*"' | cut -d'"' -f4)"
    br=(); for b in "${BROWSERS[@]}"; do browser_server_up "$b" && br+=("$b ✓") || br+=("$b ✗"); done
    pend="$(grep -c '^- ' "$AGENT_HOME/memory/pending.md" 2>/dev/null || echo 0)"
    jobs="$(crontab -l 2>/dev/null | grep -c "$JOB_TAG")"
    echo "🤖 $AGENT_NAME — $(jq -r '.status // "?"' <<<"$j" 2>/dev/null)"
    echo "Session: ${id:0:8} · started ${age} min ago · ${turns} Telegram msgs · context ~${ctx:-?} tokens"
    echo "Model: ${model:-unknown}$( [[ -n "${AGENT_MODEL:-}" ]] && echo " (saved: $AGENT_MODEL)")"
    echo "Browsers: ${br[*]}"
    echo "Laptop: RAM $(free -h | awk '/^Mem/ {print $7" free of "$2}') · up $(uptime -p | sed 's/^up //')"
    echo "Pending on owner: $pend · scheduled jobs: $jobs" ;;

  usage)   # Claude plan limits, from the status JSON that bin/statusline.sh saves on every status-line refresh
    f="$STATE_DIR/statusline.json"
    [[ -s "$f" ]] || { echo "No usage data yet — it appears after my next reply."; exit 0; }
    u="$STATE_DIR/usage.json"; [[ -s "$u" ]] || u="$f"
    jq -r --argjson now "$(date +%s)" --arg asof "$(date -d "@$(stat -c %Y "$u")" '+%H:%M')" \
       --slurpfile u "$u" '
      def bar(p): ([range(0; (p / 10 | round))] | map("▓") | join("")) + ([range(0; 10 - (p / 10 | round))] | map("░") | join(""));
      def left(t): ((t - $now) / 60 | floor) as $m | if $m <= 0 then "now" elif $m < 60 then "\($m)m" else "\($m / 60 | floor)h \($m % 60)m" end;
      def when(t): (t | localtime | strftime("%a %d %b %H:%M"));
      def line(name; r): if r == null then "\(name): n/a"
        elif r.resets_at <= $now then "\(name): reset ✓ (since \(when(r.resets_at)))"
        else "\(name): \(bar(r.used_percentage)) \(r.used_percentage | round)% used\n   resets \(when(r.resets_at)) (in \(left(r.resets_at)))" end;
      .rate_limits = ($u[0].rate_limits // .rate_limits) |
      "📊 Claude usage (as of \($asof))",
      line("⏱ 5-hour"; .rate_limits.five_hour),
      line("📅 Weekly"; .rate_limits.seven_day),
      "🧠 \(.model.display_name // "?") · this chat \(.context_window.used_percentage // "?" | tostring)% of context"
    ' "$f" ;;

  restart)
    detach restart "$WAIT_IDLE
tmux kill-session -t '$TMUX_SESSION' 2>/dev/null
sleep 3
'$BIN_DIR/start-agent.sh'
log session 'full restart done'"
    echo "OK: full restart (browsers + Claude) a few seconds after this turn ends; back in ~1 min." ;;

  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
