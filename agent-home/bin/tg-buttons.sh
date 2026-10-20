#!/usr/bin/env bash
# Sends the owner a Telegram message with tap-to-select buttons (a one-time reply keyboard under the chat input).
# Tapping a button sends the button's label as a normal message, so it reaches the agent like typed text.
# The keyboard hides itself after one tap; step-watch.py also hides it when the owner types a reply instead
# (this script leaves the keyboard-open flag file for it).
#   tg-buttons.sh [--cols N] "<message text>" "<button 1>" "<button 2>" ...
#   tg-buttons.sh --hide "<message text>"        # send text and remove any open keyboard
# Use this instead of the reply tool when the owner should pick from a few options; don't also send a reply.
set -euo pipefail
. "$(dirname "$0")/common.sh"
cols=2; hide=0
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --cols) cols="$2"; shift 2 ;;
        --hide) hide=1; shift ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done
text="${1:?usage: tg-buttons.sh [--cols N] \"text\" \"button\" ...}"; shift
token="$(env_get "$TELEGRAM_ENV" TELEGRAM_BOT_TOKEN)"
chat_id="$(env_get "$ENV_FILE" TELEGRAM_CHAT_ID)"
[[ -n "$token" && -n "$chat_id" ]] || { echo "Missing bot token or TELEGRAM_CHAT_ID" >&2; exit 1; }
(( hide == 0 && $# == 0 )) && { echo "give at least one button (or --hide)" >&2; exit 1; }
KB_FLAG="$STATE_DIR/keyboard-open" TOKEN="$token" CHAT="$chat_id" COLS="$cols" HIDE="$hide" TEXT="$text" python3 - "$@" <<'EOF'
import json, os, sys, urllib.request
buttons = [b[:60] for b in sys.argv[1:]]
cols = max(1, int(os.environ["COLS"]))
if os.environ["HIDE"] == "1":
    markup = {"remove_keyboard": True}
else:
    markup = {"keyboard": [[{"text": b} for b in buttons[i:i + cols]] for i in range(0, len(buttons), cols)],
              "one_time_keyboard": True, "resize_keyboard": True, "input_field_placeholder": "Tap an option…"}
body = {"chat_id": os.environ["CHAT"], "text": os.environ["TEXT"][:4096], "reply_markup": markup}
req = urllib.request.Request(f"https://api.telegram.org/bot{os.environ['TOKEN']}/sendMessage",
                             json.dumps(body).encode(), {"Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=20))
except Exception as e:
    sys.exit(f"tg-buttons: send failed: {e}")
if r.get("ok"):
    flag = os.environ["KB_FLAG"]
    if os.environ["HIDE"] == "1":
        if os.path.exists(flag): os.remove(flag)
    else:
        open(flag, "w").write(str(r["result"]["message_id"]))
print(f"sent message {r['result']['message_id']} with {len(buttons)} button(s)" if r.get("ok") else f"tg-buttons: {r}")
EOF
