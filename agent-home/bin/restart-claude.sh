#!/usr/bin/env bash
# Nightly restart (cron, 04:00): kills the main Claude session (and its Telegram plugin child);
# start-claude.sh's loop relaunches it with a fresh context. Also frees memory a long session accumulates.
set -uo pipefail
. "$(dirname "$0")/common.sh"

pids=($(main_claude_pids))
for pid in "${pids[@]}"; do kill_tree "$pid"; done
log claude "nightly restart: stopped ${#pids[@]} main session process(es)"

# If the agent wasn't running at all (e.g. tmux was closed), bring it back.
sleep 15
"$BIN_DIR/start-agent.sh"
