#!/usr/bin/env bash
# Runs the login helper (login-helper.mjs) and restarts it if it exits. Optional: AGENT_LOGIN_HELPER=1.
set -uo pipefail
. "$(dirname "$0")/common.sh"
printf '\033]2;Agent - Login helper\007'

export LOGIN_HELPER_PORT="$LOGIN_PORT" CDP_URL="http://127.0.0.1:$CDP_PORT" LOGIN_TOKEN_FILE

while true; do
    log login-helper 'starting'
    node "$BIN_DIR/login-helper.mjs" 2>&1 | tee -a "$LOG_DIR/login-helper.log"
    log login-helper "exited with code ${PIPESTATUS[0]}; restarting in 5s"
    sleep 5
done
