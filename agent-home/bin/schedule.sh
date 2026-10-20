#!/usr/bin/env bash
# Durable scheduled jobs backed by the user crontab (survive restarts, no 7-day expiry).
#
#   schedule.sh add <name> "<when>" ["<prompt>"]   (prompt optional if schedules/<name>.txt already exists)
#   schedule.sh list
#   schedule.sh remove <name>
#   schedule.sh run <name>                          (run once now, for testing)
#
# <when> formats (24h local time):
#   daily 09:03 | weekdays 09:03 | weekly MON,FRI 18:07 | once 2026-10-05 14:10 | every 30m | every 2h
set -euo pipefail
. "$(dirname "$0")/common.sh"

action="${1:-}"; name="${2:-}"; when="${3:-}"; prompt="${4:-}"
die() { echo "$*" >&2; exit 1; }

check_name() {
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] ||
        die "Job name must be lowercase letters, digits and dashes (max 40), got '$name'"
}

hhmm() {  # hhmm "9:03" -> sets $H $M
    [[ "$1" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || die "Bad time '$1' (use HH:MM)"
    H=$((10#${BASH_REMATCH[1]})); M=$((10#${BASH_REMATCH[2]}))
    ((H < 24 && M < 60)) || die "Bad time '$1'"
}

# Converts <when> into a cron schedule ($CRON) and extra run-task args ($EXTRA).
to_cron() {
    local s="${1#"${1%%[![:space:]]*}"}" n off d days=()
    EXTRA=''
    if [[ "$s" =~ ^daily\ ([0-9:]+)$ ]]; then
        hhmm "${BASH_REMATCH[1]}"; CRON="$M $H * * *"
    elif [[ "$s" =~ ^weekdays\ ([0-9:]+)$ ]]; then
        hhmm "${BASH_REMATCH[1]}"; CRON="$M $H * * 1-5"
    elif [[ "$s" =~ ^weekly\ ([A-Za-z,]+)\ ([0-9:]+)$ ]]; then
        local dayspec="${BASH_REMATCH[1]}"; hhmm "${BASH_REMATCH[2]}"
        IFS=, read -ra parts <<< "$dayspec"
        for d in "${parts[@]}"; do
            d="${d^^}"; d="${d:0:3}"
            [[ " MON TUE WED THU FRI SAT SUN " == *" $d "* ]] || die "Unknown day '$d'"
            days+=("$d")
        done
        CRON="$M $H * * $(IFS=,; echo "${days[*]}")"
    elif [[ "$s" =~ ^once\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9:]+)$ ]]; then
        local day="${BASH_REMATCH[1]}" at; hhmm "${BASH_REMATCH[2]}"
        at=$(date -d "$day $H:$M" +%s 2>/dev/null) || die "Bad date '$day'"
        ((at > $(date +%s))) || die "Time $s is in the past"
        ((at < $(date +%s) + 360 * 86400)) || die "'once' must be within the next year"
        CRON="$M $H $(date -d "@$at" +%-d) $(date -d "@$at" +%-m) *"; EXTRA=' --once'
    elif [[ "$s" =~ ^every\ ([0-9]+)(m|h)$ ]]; then
        n=$((10#${BASH_REMATCH[1]}))
        [[ ${BASH_REMATCH[2]} == m && $n -ge 60 && $((n % 60)) -eq 0 ]] && { n=$((n / 60)); BASH_REMATCH[2]=h; }
        if [[ ${BASH_REMATCH[2]} == m ]]; then
            ((n >= 5)) || die 'Minimum interval is 5 minutes'
            ((60 % n == 0)) || die "Every ${n}m doesn't divide an hour; use one of 5,6,10,12,15,20,30 minutes or whole hours"
            off=$(( (10#$(date +%M) + 1) % n ))   # first run in about a minute, like the Windows version
            CRON="$off-59/$n * * * *"
        else
            ((n >= 1 && 24 % n == 0)) || die "Every ${n}h doesn't divide a day; use 1,2,3,4,6,8,12 hours (or 'daily')"
            CRON="$(( (10#$(date +%M) + 1) % 60 )) */$n * * *"
        fi
    else
        die "Unrecognized schedule '$1'. Use: daily HH:MM | weekdays HH:MM | weekly MON,FRI HH:MM | once YYYY-MM-DD HH:MM | every Nm | every Nh"
    fi
}

other_lines() { crontab -l 2>/dev/null | grep -vF "$JOB_TAG$name |" || true; }

case "$action" in
    add)
        check_name
        [[ -n "$when" ]] || die 'Missing <when>'
        prompt_file="$AGENT_HOME/schedules/$name.txt"
        to_cron "$when"
        if [[ -n "$prompt" ]]; then
            printf '%s\n' "$prompt" > "$prompt_file"
        elif [[ ! -f "$prompt_file" ]]; then
            die "No prompt given and $prompt_file doesn't exist. Write the prompt to that file first."
        fi
        { other_lines; echo "$CRON $BIN_DIR/run-task.sh $name$EXTRA >/dev/null 2>&1 $JOB_TAG$name | $when"; } | crontab -
        echo "Scheduled '$name' ($when) -> cron '$CRON'."
        ;;
    list)
        lines="$(crontab -l 2>/dev/null | grep -F "$JOB_TAG" || true)"
        [[ -n "$lines" ]] || { echo 'No scheduled jobs.'; exit 0; }
        while IFS= read -r line; do
            tag="${line##*"$JOB_TAG"}"; job="${tag%% | *}"; spec="${tag#* | }"
            last="$(ls -t "$LOG_DIR"/job-"$job"-*.log 2>/dev/null | head -n1 || true)"
            if [[ -n "$last" ]]; then
                last="$(date -r "$last" '+%Y-%m-%d %H:%M') (exit $(sed -n 's/^exit: //p' "$last"))"
            else
                last='never'
            fi
            pf="$AGENT_HOME/schedules/$job.txt"
            preview="$( [[ -f "$pf" ]] && tr -s '[:space:]' ' ' < "$pf" || echo '(missing prompt file)')"
            ((${#preview} > 100)) && preview="${preview:0:100}..."
            printf -- '- %s | %s | last: %s\n    %s\n' "$job" "$spec" "$last" "$preview"
        done <<< "$lines"
        ;;
    remove)
        check_name
        other_lines | crontab -
        rm -f "$AGENT_HOME/schedules/$name.txt"
        echo "Removed '$name'."
        ;;
    run)
        check_name
        [[ -f "$AGENT_HOME/schedules/$name.txt" ]] || die "No job '$name' (schedules/$name.txt missing)"
        setsid nohup "$BIN_DIR/run-task.sh" "$name" >/dev/null 2>&1 < /dev/null &
        echo "Started '$name'. The result will arrive on Telegram when it finishes."
        ;;
    *)
        sed -n '2,10p' "$0"; exit 1 ;;
esac
