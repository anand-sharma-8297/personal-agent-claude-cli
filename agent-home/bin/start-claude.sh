#!/usr/bin/env bash
# Runs the main Claude Code session with the Telegram channel, and relaunches it whenever it exits
# (crash, or the nightly restart killing it for a fresh context). Runs in tmux window "agent:claude".
set -uo pipefail
. "$(dirname "$0")/common.sh"
printf '\033]2;%s - Claude (Telegram)\007' "$AGENT_NAME"
# App channel (app/channel.mjs): only this main session takes the owner's app messages (scheduled jobs don't).
export APP_LISTEN=1
cd "$AGENT_HOME"

# Pin Claude Code's MCP client to the v1 runtime: on v2 (Claude Code 2.1.289) the Telegram channel
# plugin's server never connected in the main session, so no messages arrived. Remove this line
# to test v2 again after a Claude Code update.
export MCP_SDK_GENERATION=v1

while true; do
    # Wait for the browser servers so the Playwright tools are connected at startup.
    for ((waited = 0; waited < 120; waited += 2)); do browser_server_up && break; sleep 2; done

    args=(--channels "$CHANNEL_PLUGIN" --permission-mode dontAsk --name "$AGENT_NAME")
    # The app channel (app/channel.mjs, in .mcp.json) is our own, not an approved plugin, so it loads as a development
    # channel. That shows a "Loading development channels" warning at every start: confirm it automatically.
    args+=(--dangerously-load-development-channels server:app)
    ( for _ in $(seq 60); do
          sleep 1
          if tmux capture-pane -p -t "${TMUX_PANE:-agent:claude}" 2>/dev/null | grep -q 'I am using this for local development'; then
              tmux send-keys -t "${TMUX_PANE:-agent:claude}" Enter; break
          fi
      done ) &
    # Remote Control: the session also shows up in the Claude app / claude.ai/code (AGENT_REMOTE_CONTROL=0 turns it off).
    [[ "$(env_get "$ENV_FILE" AGENT_REMOTE_CONTROL)" == 0 ]] || args+=(--remote-control "$AGENT_NAME")
    model="$(env_get "$ENV_FILE" AGENT_MODEL)"
    [[ -n "$model" ]] && args+=(--model "$model")
    # AGENT_DEBUG=1 in ~/.agent.env writes Claude Code's debug log to logs/claude-debug.log
    [[ "$(env_get "$ENV_FILE" AGENT_DEBUG)" == 1 ]] && args+=(--debug --debug-file "$LOG_DIR/claude-debug.log")
    resume_file="$STATE_DIR/resume-session"   # written by bin/session.sh resume (Telegram /resume); used once
    if [[ -s "$resume_file" ]]; then
        rid="$(head -n1 "$resume_file")"; rm -f "$resume_file"
        [[ "$rid" =~ ^[0-9a-f-]{36}$ ]] && args+=(--resume "$rid") && log claude "resuming session $rid"
    fi

    log claude 'starting main session'
    claude "${args[@]}"
    log claude "main session exited with code $?; restarting in 10s"
    sleep 10
done
