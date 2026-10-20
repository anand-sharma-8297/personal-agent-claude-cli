#!/usr/bin/env bash
# statusline.sh — Claude Code status line (the agent via agent-home/.claude/settings.json, admin sessions via
# ~/.claude/settings.json if you add it there). Every session saves the plan usage (rate_limits, shared by the whole account) to
# usage.json — read by the pinned Telegram status (step-watch.py) and `session.sh usage`. The agent's session also
# saves its full status JSON (model, context) to statusline.json. Prints a short line.
d="$HOME/.local/state/personal-agent"
in="$(cat)"
if [[ "$(jq -r '.workspace.project_dir // .cwd' <<<"$in" 2>/dev/null)" == "$HOME/agent-home" ]]; then
    printf '%s' "$in" > "$d/statusline.json.tmp" && mv -f "$d/statusline.json.tmp" "$d/statusline.json"
    jq -c '{rate_limits, model: .model.display_name, at: now}' <<<"$in" > "$d/usage.json.tmp" 2>/dev/null \
        && mv -f "$d/usage.json.tmp" "$d/usage.json"
elif jq -e '.rate_limits.five_hour' <<<"$in" >/dev/null 2>&1; then   # admin session: update usage, keep the agent's model
    jq -c --slurpfile o "$d/usage.json" '{rate_limits, model: ($o[0].model // "?"), at: now}' <<<"$in" \
        > "$d/usage.json.tmp" 2>/dev/null && mv -f "$d/usage.json.tmp" "$d/usage.json"
fi
jq -r '"\(.model.display_name // "?") · 5h \(.rate_limits.five_hour.used_percentage // "?")% · week \(.rate_limits.seven_day.used_percentage // "?")%"' <<<"$in" 2>/dev/null
