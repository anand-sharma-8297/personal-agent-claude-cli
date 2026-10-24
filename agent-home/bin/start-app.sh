#!/usr/bin/env bash
# Runs the agent's app server (app/server.mjs) and restarts it if it exits. Tmux window "agent:app".
set -uo pipefail
. "$(dirname "$0")/common.sh"
printf '\033]2;%s - App server\007' "$AGENT_NAME"
while true; do
    log app 'starting app server'
    node "$AGENT_HOME/app/server.mjs" 2>&1 | tee -a "$LOG_DIR/app.log"
    log app "app server exited with code ${PIPESTATUS[0]}; restarting in 5s"
    sleep 5
done
