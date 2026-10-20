#!/usr/bin/env bash
# Stops the agent and removes its autostart and cron entries. Keeps ~/agent-home (memory, files), the browser
# profiles and your settings, so running the installer again brings everything back. Delete those yourself if
# you want them gone: ~/agent-home ~/browser-personal ~/browser-work ~/.agent.env ~/.claude/channels/telegram
set -uo pipefail
tmux kill-session -t agent 2>/dev/null && echo "Stopped the agent."
rm -f "$HOME/.config/autostart/personal-agent.desktop"
crontab -l 2>/dev/null | grep -vE '# agent-(system|job):' | crontab -
echo "Removed autostart and cron entries. Your data is still in ~/agent-home."
