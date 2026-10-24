#!/usr/bin/env bash
# The owner's private link to the app: https://<this laptop's Tailscale name>:8443/?t=<token>.
#   app-link.sh            send it to the owner on Telegram (prints only "sent", so the link stays out of the chat log)
#   app-link.sh --print    print it (used by the setup wizard)
set -euo pipefail
. "$(dirname "$0")/common.sh"
token="$(jq -r '.token // empty' "$STATE_DIR/app/app.json" 2>/dev/null)"
host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
[[ -n "$token" ]] || { echo "The app is not set up yet (no $STATE_DIR/app/app.json)." >&2; exit 1; }
[[ -n "$host" ]] || { echo "Tailscale is not connected, so there is no app address." >&2; exit 1; }
url="https://$host:8443/?t=$token"
if [[ "${1:-}" == --print ]]; then echo "$url"; exit 0; fi
"$BIN_DIR/notify.sh" --telegram "📱 Your $AGENT_NAME app (keep this link private):
$url

Open it on your phone (Tailscale on), then:
• iPhone: Share → Add to Home Screen
• Android (Chrome): ⋮ → Install app
Then open the app → menu → Turn on notifications."
echo sent
