#!/usr/bin/env bash
# Creates a one-time login link for the owner's phone and prints it.
#   login-link.sh [--browser personal|work] [--match <text in the tab's URL>] [--minutes 20]
# Opening the link (over Tailscale) shows the agent's live Chrome tab; the owner signs in themselves.
set -euo pipefail
. "$(dirname "$0")/common.sh"

match=''; minutes=20; browser=personal
while [[ $# -gt 0 ]]; do
    case "$1" in
        --match|-Match) match="$2"; shift 2 ;;
        --browser) browser="$2"; shift 2 ;;
        --minutes|-Minutes) minutes="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

cdp="${BROWSER_CDP[$browser]:-}"
[[ -n "$cdp" ]] || { echo "Unknown browser: $browser (personal|work)" >&2; exit 1; }
command -v tailscale >/dev/null || { echo 'Tailscale is not installed on this laptop. Tell the owner.' >&2; exit 1; }
ip="$(tailscale ip -4 2>/dev/null | head -n1)"
[[ -n "$ip" ]] || { echo 'Tailscale is not connected on this laptop. Tell the owner.' >&2; exit 1; }

token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
expires=$(( ($(date +%s) + minutes * 60) * 1000 ))
umask 077
jq -nc --arg token "$token" --argjson expires "$expires" --arg match "$match" --argjson cdp "$cdp" \
    '{token: $token, expires: $expires, match: $match, cdp: $cdp}' > "$LOGIN_TOKEN_FILE"

echo "http://$ip:$LOGIN_PORT/?t=$token"
echo "(valid for $minutes minutes, opens on the owner's phone only while Tailscale is on)"
