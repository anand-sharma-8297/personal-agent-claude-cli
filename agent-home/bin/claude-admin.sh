#!/usr/bin/env bash
# Use this instead of plain "claude" when you want to run Claude Code by hand on the agent laptop.
# Plain "claude" would start a second Telegram poller, which kills the main agent's Telegram connection.
exec claude --settings "$(dirname "$(realpath "$0")")/job-settings.json" "$@"
