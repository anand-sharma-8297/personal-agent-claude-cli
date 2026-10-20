#!/usr/bin/env bash
# Emergency stop. Runs in tmux window "agent:stop-watch" and checks the main Claude window every 2 s.
# When the owner sends "STOP" (capitals) on Telegram while the agent is busy, it presses Esc in the agent's
# window, which cancels the running task at once (even in the middle of a long step), then tells the owner.
# A STOP sent while the agent is idle is left to the agent itself (CLAUDE.md rule: reply "Stopped").
set -uo pipefail
. "$(dirname "$0")/common.sh"
printf '\033]2;Agent - STOP watcher\007'
pane="$TMUX_SESSION:claude"
stop_line='^← telegram · [0-9]+: (STOP|/stop)[!. ]*$'

count_stops() { tmux capture-pane -p -t "$pane" -S -300 2>/dev/null | grep -cE "$stop_line"; }
session_status() {
    local pid; pid="$(main_claude_pids | head -n1)"
    [[ -n "$pid" ]] && jq -r '.status // "idle"' "$HOME/.claude/sessions/$pid.json" 2>/dev/null || echo none
}

log stop 'stop watcher started'
last_count="$(count_stops)"; last_status="$(session_status)"
while true; do
    sleep 2
    count="$(count_stops)"; status="$(session_status)"
    if (( count > last_count )) && [[ "$last_status" == busy ]]; then
        log stop 'STOP received while busy: pressing Esc'
        tmux send-keys -t "$pane" Escape
        sleep 3
        # Normally the STOP message then reaches the agent, which replies "Stopped" itself. If it was left in
        # the input box instead, clear it and tell the owner here (otherwise they'd hear nothing).
        if tmux capture-pane -p -t "$pane" | grep -qE '^❯ (STOP|/stop)[!. ]*$'; then
            tmux send-keys -t "$pane" C-u
            "$BIN_DIR/notify.sh" "🛑 Stopped. I cancelled the task I was working on. Tell me what to do next." ||
                log stop 'notify failed'
        fi
        count="$(count_stops)"; status="$(session_status)"
    fi
    last_count="$count"; last_status="$status"
done
