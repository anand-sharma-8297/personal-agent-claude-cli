# Shared paths and helpers for the agent scripts. Source it: . "$(dirname "$0")/common.sh"

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOME="$(dirname "$BIN_DIR")"
LOG_DIR="$AGENT_HOME/logs"
ENV_FILE="$HOME/.agent.env"
TELEGRAM_ENV="$HOME/.claude/channels/telegram/.env"
CHANNEL_PLUGIN='plugin:telegram@claude-plugins-official'
JOB_TAG='# agent-job:'          # crontab lines for scheduled jobs end with "# agent-job:<name>"
TMUX_SESSION='agent'

# Two fully isolated browsers (separate Chrome profiles = separate cookies/logins), each behind its own
# Playwright MCP server. Claude sees them as the MCP servers "browser_personal" and "browser_work".
BROWSERS=(personal work)
declare -A BROWSER_PORT=([personal]=8931 [work]=8933)
declare -A BROWSER_CDP=([personal]=9222 [work]=9223)
declare -A BROWSER_PROFILE=([personal]="$HOME/browser-personal" [work]="$HOME/browser-work")
declare -A BROWSER_LABEL=([personal]=PERSONAL [work]=WORK)
CDP_PORT=${BROWSER_CDP[work]}   # login helper (optional) attaches to the work browser
LOGIN_PORT=8932                 # login helper, reachable from your Tailscale devices only
STATE_DIR="$HOME/.local/state/personal-agent"   # generated config + login tokens
LOGIN_TOKEN_FILE="$STATE_DIR/login-token.json"

mkdir -p "$LOG_DIR" "$STATE_DIR"

# If these scripts are launched from inside another Claude Code session (e.g. you asked Claude to start
# the agent), that session's markers leak into the agent and make it behave as a child session
# (no channels, no transcripts). Drop them so the agent always starts as its own top-level session.
unset CLAUDECODE CLAUDE_PID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT \
      CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
      CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_SESSION_ID

# cron and SSH give a minimal environment: make sure claude, bun and node are found, and that Chrome
# can reach the desktop session (needed when cron or SSH starts the browser servers).
[[ "${LANG:-}" == *UTF-8* ]] || export LANG=C.UTF-8   # cron runs with LANG unset
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -z "${DISPLAY:-}" ]]; then
    export DISPLAY=:0
    [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] && export WAYLAND_DISPLAY=wayland-0
    for xa in "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* "$XDG_RUNTIME_DIR/gdm/Xauthority"; do
        [[ -f "$xa" ]] && { export XAUTHORITY="$xa"; break; }
    done
fi
[[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]] &&
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

# Reads KEY=value lines (quotes stripped) from a file without executing it.
env_get() {  # env_get <file> <key>
    [[ -f "$1" ]] || return 0
    sed -n -E "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*\$/\1/p" "$1" |
        tail -n1 | sed -E "s/^[\"'](.*)[\"']\$/\1/"
}

AGENT_MODEL="$(env_get "$ENV_FILE" AGENT_MODEL)"
AGENT_NAME="$(env_get "$ENV_FILE" AGENT_NAME)"; AGENT_NAME="${AGENT_NAME:-Agent}"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# True when every browser server (or the named one) is listening.
browser_server_up() {
    local n
    for n in "${@:-${BROWSERS[@]}}"; do port_open "${BROWSER_PORT[$n]}" || return 1; done
}

# PIDs of the main (Telegram) Claude session: a "claude" process whose arguments include --channels.
main_claude_pids() {
    local pid
    for pid in $(pgrep -u "$(id -u)" -x claude); do
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- '--channels' && echo "$pid"
    done
}

log() {  # log <name> <message>
    printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$2" >> "$LOG_DIR/$1.log"
}

# Stops a process and all its children (e.g. the main session and its Telegram plugin server).
kill_tree() {
    local child
    for child in $(pgrep -P "$1"); do kill_tree "$child"; done
    kill -TERM "$1" 2>/dev/null
}

# True if this agent script (with exactly these arguments) is running. Matches the whole command line, so
# commands that merely mention the script's name (e.g. in a grep) don't count.
script_running() {  # script_running <script.sh> [args...]
    local pattern="^bash $BIN_DIR/$1"; shift
    [[ $# -gt 0 ]] && pattern+=" $*"
    pgrep -u "$(id -u)" -f "${pattern}\$" >/dev/null
}
