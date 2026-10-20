#!/usr/bin/env bash
# Runs one scheduled job: a fresh headless Claude session (claude -p) with the shared browsers,
# then sends its final answer to Telegram. Called by cron: run-task.sh <job> [--once]
# (--once: a one-time job; its crontab line is removed after it runs.)
set -uo pipefail
. "$(dirname "$0")/common.sh"

name="${1:?Usage: run-task.sh <job> [--once]}"
once="${2:-}"
notify="$BIN_DIR/notify.sh"
prompt_file="$AGENT_HOME/schedules/$name.txt"
log_file="$LOG_DIR/job-$name-$(date +%Y-%m-%d_%H%M).log"
timeout_min=30

if [[ "$once" == --once ]]; then
    crontab -l 2>/dev/null | grep -vF "$JOB_TAG$name |" | crontab -
fi

if [[ ! -f "$prompt_file" ]]; then
    "$notify" "Scheduled job '$name' has no prompt file ($prompt_file)."
    exit 1
fi

# Old job logs: keep 30 days.
find "$LOG_DIR" -name 'job-*.log' -mtime +30 -delete 2>/dev/null

# One job at a time, so jobs don't fight over the browser.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/agent-job.lock"
if ! flock -w $((timeout_min * 60)) 9; then
    "$notify" "Job '$name' skipped: another job has been running for over $timeout_min minutes."
    exit 1
fi

job_note='You are running as an unattended SCHEDULED JOB, not in the Telegram chat session.
- The Telegram plugin is not available here. Your final message is sent to the owner automatically,
  so make it the finished result: short and clear. Don'\''t describe your steps.
- To send a screenshot or file, run:
  bin/notify.sh --file "<path>" "<caption>"
- Nobody can answer questions during this run. Never do irreversible actions here; if one is needed, say so.
- If a site needs a login, say which site in your final message.
- Use your own browser tab and close it when finished.

The job:'

# --strict-mcp-config + job settings keep the Telegram plugin OFF here: a second poller on the
# same bot token would kill the main session's Telegram connection.
args=(-p --permission-mode dontAsk --strict-mcp-config
      --mcp-config "$BIN_DIR/job-mcp.json" --settings "$BIN_DIR/job-settings.json")
[[ -n "$AGENT_MODEL" ]] && args+=(--model "$AGENT_MODEL")

cd "$AGENT_HOME"
out_file="$(mktemp)"; err_file="$(mktemp)"
trap 'rm -f "$out_file" "$err_file"' EXIT
{ printf '%s\n' "$job_note"; cat "$prompt_file"; } |
    timeout --kill-after=30s "${timeout_min}m" claude "${args[@]}" > "$out_file" 2> "$err_file"
code=$?
timed_out=false; [[ $code -eq 124 || $code -eq 137 ]] && timed_out=true
out="$(cat "$out_file")"; err="$(cat "$err_file")"

printf 'job: %s\nexit: %s\ntimedOut: %s\n--- stdout ---\n%s\n--- stderr ---\n%s\n' \
    "$name" "$code" "$timed_out" "$out" "$err" > "$log_file"

if $timed_out; then
    "$notify" "Job '$name' timed out after $timeout_min minutes. Log: $log_file"
elif [[ $code -ne 0 || -z "${out//[[:space:]]/}" ]]; then
    "$notify" "Job '$name' failed (exit $code).
${err: -500}
Log: $log_file"
else
    "$notify" "[$name]

$out"
fi
