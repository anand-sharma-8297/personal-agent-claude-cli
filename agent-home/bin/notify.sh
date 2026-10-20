#!/usr/bin/env bash
# Sends a Telegram message (and optionally a file) to the owner, outside the main Claude session.
# Used by scheduled jobs, which run without the Telegram plugin.
#   notify.sh "text"
#   notify.sh --file /path/shot.png "caption"
set -euo pipefail
. "$(dirname "$0")/common.sh"

file=''
if [[ "${1:-}" == --file || "${1:-}" == -File ]]; then file="$2"; shift 2; fi
text="${1:-}"

token="$(env_get "$TELEGRAM_ENV" TELEGRAM_BOT_TOKEN)"
token="${token:-${TELEGRAM_BOT_TOKEN:-}}"
chat_id="$(env_get "$ENV_FILE" TELEGRAM_CHAT_ID)"
if [[ -z "$token" || -z "$chat_id" ]]; then
    echo "Missing TELEGRAM_BOT_TOKEN ($TELEGRAM_ENV) or TELEGRAM_CHAT_ID ($ENV_FILE)" >&2
    exit 1
fi
api="https://api.telegram.org/bot$token"

if [[ -n "$file" ]]; then
    file="$(realpath "$file")"
    case "${file,,}" in
        *.png|*.jpg|*.jpeg|*.webp) method=sendPhoto; field=photo ;;
        *) method=sendDocument; field=document ;;
    esac
    # Caption via a temp file (-F "caption=<file") so no character in it is special to curl.
    caption_file="$(mktemp)"
    trap 'rm -f "$caption_file"' EXIT
    printf '%s' "${text:0:1000}" > "$caption_file"
    curl -sS -o /dev/null --fail -F "chat_id=$chat_id" -F "$field=@$file" -F "caption=<$caption_file" "$api/$method" ||
        { echo "Telegram $method failed" >&2; exit 1; }
    exit 0
fi

# Text: Telegram allows 4096 chars per message, so send in chunks.
for ((i = 0; i < ${#text}; i += 4000)); do
    curl -sS -o /dev/null --fail --data-urlencode "chat_id=$chat_id" --data-urlencode "text=${text:i:4000}" \
        "$api/sendMessage" || { echo "Telegram sendMessage failed" >&2; exit 1; }
done
