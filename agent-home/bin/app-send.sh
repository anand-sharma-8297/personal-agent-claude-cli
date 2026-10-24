#!/usr/bin/env bash
# Posts a message into the agent's app (app/server.mjs) from outside the main Claude session.
#   app-send.sh [--system] [--file /path] "text"
# --system shows it as a status line instead of an agent message. Fails quietly if the app server is down.
set -euo pipefail
. "$(dirname "$0")/common.sh"
system=false; alert=false; files='[]'
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --system) system=true; shift ;;
        --alert) alert=true; shift ;;   # wait for the push; exit 3 if nobody will see it (notify.sh then uses Telegram)
        --file|-File) files="$(jq -nc --arg f "$(realpath "$2")" '[$f]')"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done
secret="$(jq -r '.bridge // empty' "$STATE_DIR/app/app.json" 2>/dev/null)"
[[ -n "$secret" ]] || { echo "Agent app not set up" >&2; exit 1; }
resp="$(jq -nc --arg text "${1:-}" --argjson system "$system" --argjson alert "$alert" --argjson files "$files" \
        '{text: $text, system: $system, alert: $alert, files: $files}' |
    curl -sS --fail --max-time 40 -H "X-Bridge: $secret" -H 'Content-Type: application/json' --data @- \
        http://127.0.0.1:8950/local/post)" || { echo "Agent app server not reachable" >&2; exit 1; }
if [[ "$alert" == true && "$(jq -r '.delivered' <<<"$resp")" != true ]]; then
    echo "Posted in the app, but no notification reached a device" >&2; exit 3
fi
