#!/usr/bin/env bash
# Starts the whole agent in tmux session "agent": one window per browser server + the main Claude window.
# Launched at desktop login (~/.config/autostart/personal-agent.desktop) and by the nightly restart.
# Safe to run twice: it skips what's already running. Watch it with: tmux attach -t agent
set -uo pipefail
. "$(dirname "$0")/common.sh"

# Keep the desktop awake and unlocked (Chrome must stay drawable; nobody types a password here).
if command -v gsettings >/dev/null && [[ -S "$XDG_RUNTIME_DIR/bus" ]]; then
    gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null
    gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing 2>/dev/null
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type nothing 2>/dev/null
fi

# A new window runs its script; keep it open after an unexpected exit so the error stays readable.
open_window() {  # open_window <window-name> <command...>
    local win="$1"; shift
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux new-session -d -s "$TMUX_SESSION" -n "$win" -c "$AGENT_HOME" "$@"
        tmux set-option -t "$TMUX_SESSION" remain-on-exit on
        tmux set-option -t "$TMUX_SESSION" history-limit 20000
    else
        # New windows take DISPLAY etc. from the tmux session, not from this script: refresh them in case
        # the session was started without a desktop (e.g. from SSH).
        local v
        for v in DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR PATH; do
            [[ -n "${!v:-}" ]] && tmux set-environment -t "$TMUX_SESSION" "$v" "${!v}"
        done
        tmux kill-window -t "$TMUX_SESSION:$win" 2>/dev/null   # a dead leftover window
        tmux new-window -d -t "$TMUX_SESSION" -n "$win" -c "$AGENT_HOME" "$@"
    fi
}

for name in "${BROWSERS[@]}"; do
    if ! browser_server_up "$name" && ! script_running start-browser.sh "$name"; then
        open_window "browser-$name" "$BIN_DIR/start-browser.sh" "$name"
        log agent "launched browser server ($name)"
    fi
done

# Optional phone login helper (login-helper.mjs). Off by default; set AGENT_LOGIN_HELPER=1 in ~/.agent.env to use it.
if [[ "$(env_get "$ENV_FILE" AGENT_LOGIN_HELPER)" == 1 ]] && ! pgrep -u "$(id -u)" -f login-helper.mjs >/dev/null; then
    open_window login-helper "$BIN_DIR/start-login-helper.sh"
    log agent 'launched login helper'
fi

# Emergency STOP watcher (owner sends "STOP" on Telegram -> Esc in the Claude window).
if ! script_running stop-watcher.sh; then
    open_window stop-watch "$BIN_DIR/stop-watcher.sh"
    log agent 'launched STOP watcher'
fi

# Live step feed on Telegram (italic progress message per task, deleted when the answer is sent).
if ! script_running step-watch.sh; then
    open_window step-watch "$BIN_DIR/step-watch.sh"
    log agent 'launched step watcher'
fi

# App server (the agent's own chat app; app/server.mjs). Keeps running while Claude restarts.
if ! script_running start-app.sh; then
    open_window app "$BIN_DIR/start-app.sh"
    log agent 'launched app server'
fi

if [[ -z "$(main_claude_pids)" ]] && ! script_running start-claude.sh; then
    open_window claude "$BIN_DIR/start-claude.sh"
    log agent 'launched main Claude session'
fi
