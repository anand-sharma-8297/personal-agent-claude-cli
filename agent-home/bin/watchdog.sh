#!/usr/bin/env bash
# Cron, every 5 minutes: makes sure the agent is up and actually connected to Telegram.
# Seen on Ubuntu: right after install/reboot the main session sometimes started without launching the
# Telegram plugin server (no bun process), so messages were silently ignored. Restart it when that happens.
set -uo pipefail
. "$(dirname "$0")/common.sh"

# Nobody logged in to the desktop yet (e.g. just booted): autostart will handle it.
[[ -S "$XDG_RUNTIME_DIR/bus" ]] || exit 0

pids=($(main_claude_pids))
if [[ ${#pids[@]} -eq 0 ]]; then
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null && script_running start-claude.sh && exit 0
    log agent 'watchdog: agent not running, starting it'
    exec "$BIN_DIR/start-agent.sh"
fi

# The STOP watcher must always run; start-agent.sh only starts what's missing.
script_running stop-watcher.sh || "$BIN_DIR/start-agent.sh"
script_running step-watch.sh || "$BIN_DIR/start-agent.sh"

has_telegram() {  # is a "bun ... server.ts" process a descendant of $1?
    local child
    for child in $(pgrep -P "$1"); do
        tr '\0' ' ' < "/proc/$child/cmdline" 2>/dev/null | grep -q 'bun.*server\.ts' && return 0
        has_telegram "$child" && return 0
    done
    return 1
}

for pid in "${pids[@]}"; do
    # Give a fresh session 2 minutes to connect before judging it.
    (( $(ps -o etimes= -p "$pid") < 120 )) && continue
    if ! has_telegram "$pid"; then
        log claude "watchdog: main session $pid has no Telegram plugin server; restarting it"
        kill -TERM "$pid"
    fi
done

# Deaf poller: the plugin process can stay alive but stop collecting messages (seen after a reboot: it gives up
# after repeated 409 Conflicts). Telegram then holds the owner's messages undelivered. If messages are still
# waiting on two checks in a row (~5 min apart), restart the session. getWebhookInfo only reads the count.
deaf_flag="$STATE_DIR/telegram-undelivered"
token="$(env_get "$TELEGRAM_ENV" TELEGRAM_BOT_TOKEN)"
waiting="$(curl -s --max-time 15 "https://api.telegram.org/bot$token/getWebhookInfo" | jq -r '.result.pending_update_count // empty' 2>/dev/null)"
if [[ "$waiting" =~ ^[1-9][0-9]*$ && ${#pids[@]} -gt 0 ]] && (( $(ps -o etimes= -p "${pids[0]}") >= 180 )); then
    if [[ -f "$deaf_flag" ]]; then
        log claude "watchdog: $waiting Telegram message(s) undelivered for 5+ min; restarting main session ${pids[0]}"
        rm -f "$deaf_flag"
        kill_tree "${pids[0]}"
        exit 0
    fi
    touch "$deaf_flag"
else
    rm -f "$deaf_flag"
fi

# Idle restart: after IDLE_RESTART_MIN minutes without activity, start a fresh session so the context
# doesn't keep growing (and a stale, uncached context isn't re-sent in full with the next message).
# Skipped while the agent is busy, while it waits for an answer (memory/pending.md), and for sessions
# that never received a Telegram message (restarting those gains nothing).
idle_min="$(env_get "$ENV_FILE" IDLE_RESTART_MIN)"; idle_min="${idle_min:-120}"
[[ "$idle_min" == 0 ]] && exit 0
pending="$AGENT_HOME/memory/pending.md"
for pid in "${pids[@]}"; do
    info="$HOME/.claude/sessions/$pid.json"
    [[ -f "$info" ]] || continue
    sid="$(jq -r '.sessionId // empty' "$info")"; status="$(jq -r '.status // "idle"' "$info")"
    transcript="$HOME/.claude/projects/$(sed 's#[^A-Za-z0-9]#-#g' <<< "$AGENT_HOME")/$sid.jsonl"
    [[ -n "$sid" && -f "$transcript" ]] || continue
    [[ "$status" == idle ]] || continue
    idle=$(( ($(date +%s) - $(stat -c %Y "$transcript")) / 60 ))
    (( idle >= idle_min )) || continue
    grep -qF '"kind":"channel"' "$transcript" || continue
    if [[ -f "$pending" ]] && grep -qE '^[[:space:]]*-' "$pending"; then
        continue   # waiting for my answer: keep the conversation
    fi
    log claude "idle restart: main session $pid idle for ${idle} min; starting a fresh session"
    kill_tree "$pid"
done
