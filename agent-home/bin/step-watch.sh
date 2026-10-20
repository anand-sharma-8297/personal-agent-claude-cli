#!/usr/bin/env bash
# Live step feed on Telegram (see step-watch.py).
#   step-watch.sh          run the watcher (started by start-agent.sh in tmux window "step-watch")
#   step-watch.sh on|off   turn the Telegram progress messages on/off (watcher keeps running)
#   step-watch.sh status
set -uo pipefail
. "$(dirname "$0")/common.sh"
off="$STATE_DIR/watch-off"
case "${1:-run}" in
  on)     rm -f "$off"; echo "Live steps: ON" ;;
  off)    mkdir -p "$STATE_DIR"; touch "$off"; echo "Live steps: OFF" ;;
  status) [[ -f "$off" ]] && echo "Live steps: OFF" || echo "Live steps: ON" ;;
  run)    printf '\033]2;Agent - step watcher\007'
          while true; do
              python3 "$BIN_DIR/step-watch.py"
              log agent "step watcher exited ($?); restarting in 5s"
              sleep 5
          done ;;
  *)      sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
