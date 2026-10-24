#!/usr/bin/env bash
# Sends an alert (and optionally a file) to the owner, outside the main Claude session.
# Used by scheduled jobs, watchers and scripts.
#   notify.sh "text"
#   notify.sh --file /path/shot.png "caption"
#   notify.sh --telegram "text"     Telegram only (replies to something the owner did on Telegram, e.g. STOP)
# Where it goes:
#   - the app first, with a phone notification;
#   - Telegram only as a backup, when the app server is down or no notification reached a device;
#   - with NOTIFY_ALSO_TELEGRAM=1 in the environment (e.g. for urgent jobs) it goes to both.
set -euo pipefail
. "$(dirname "$0")/common.sh"

only_telegram=false; file=''
while [[ "${1:-}" == --* || "${1:-}" == -File ]]; do
    case "$1" in
        --telegram) only_telegram=true; shift ;;
        --file|-File) file="$(realpath "$2")"; shift 2 ;;
        *) break ;;
    esac
done
text="${1:-}"

telegram() {
    local token chat_id api
    token="$(env_get "$TELEGRAM_ENV" TELEGRAM_BOT_TOKEN)"
    token="${token:-${TELEGRAM_BOT_TOKEN:-}}"
    chat_id="$(env_get "$ENV_FILE" TELEGRAM_CHAT_ID)"
    if [[ -z "$token" || -z "$chat_id" ]]; then
        echo "Missing TELEGRAM_BOT_TOKEN ($TELEGRAM_ENV) or TELEGRAM_CHAT_ID ($ENV_FILE)" >&2
        return 1
    fi
    api="https://api.telegram.org/bot$token"
    if [[ -n "$file" ]]; then
        local method field caption_file
        case "${file,,}" in
            *.png|*.jpg|*.jpeg|*.webp) method=sendPhoto; field=photo ;;
            *) method=sendDocument; field=document ;;
        esac
        # Caption via a temp file (-F "caption=<file") so no character in it is special to curl.
        caption_file="$(mktemp)"
        printf '%s' "${text:0:1000}" > "$caption_file"
        curl -sS -o /dev/null --fail -F "chat_id=$chat_id" -F "$field=@$file" -F "caption=<$caption_file" "$api/$method" ||
            { rm -f "$caption_file"; echo "Telegram $method failed" >&2; return 1; }
        rm -f "$caption_file"
        return 0
    fi
    # Text: Telegram allows 4096 chars per message, so send in chunks.
    for ((i = 0; i < ${#text}; i += 4000)); do
        curl -sS -o /dev/null --fail --data-urlencode "chat_id=$chat_id" --data-urlencode "text=${text:i:4000}" \
            "$api/sendMessage" || { echo "Telegram sendMessage failed" >&2; return 1; }
    done
}
app() {
    local opts=("$@"); [[ -n "$file" ]] && opts+=(--file "$file")
    "$BIN_DIR/app-send.sh" "${opts[@]}" "$text"
}

if [[ "$only_telegram" == true ]]; then
    telegram
    app >/dev/null 2>&1 & disown   # copy into the app, no notification needed
    exit 0
fi

if [[ "${NOTIFY_ALSO_TELEGRAM:-}" == 1 ]]; then   # trading: both, each independently
    app --alert >/dev/null 2>&1 & disown
    telegram
    exit 0
fi

code=0; app --alert || code=$?
[[ $code -eq 0 ]] && exit 0
log notify "app alert not delivered (code $code); sending on Telegram instead"
telegram
