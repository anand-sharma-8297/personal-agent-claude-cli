#!/usr/bin/env bash
# Installs/updates ~/agent-home from this kit, as your normal user. Run by the wizard after it saved your settings
# (~/.agent.env and the bot token); safe to run again: scripts and rules are replaced, while memory, schedules,
# workspace and downloads are kept.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/agent-home"
ENV_FILE="$HOME/.agent.env"
TG_DIR="$HOME/.claude/channels/telegram"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
env_get() { sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*\$/\1/p" "$ENV_FILE" 2>/dev/null | tail -n1; }

[[ $EUID -ne 0 ]] || { echo "Run as your normal user, not root." >&2; exit 1; }
for c in claude bun node npx google-chrome tmux jq crontab python3; do
    command -v "$c" >/dev/null || { echo "Missing '$c'. Run the setup wizard first." >&2; exit 1; }
done
CHAT_ID="$(env_get TELEGRAM_CHAT_ID)"
[[ "$CHAT_ID" =~ ^[0-9]+$ ]] || { echo "No TELEGRAM_CHAT_ID in $ENV_FILE. Run the setup wizard first." >&2; exit 1; }

step "Copying the agent to $DEST"
mkdir -p "$DEST"/{bin,.claude,memory/sites,memory/journal,schedules,workspace,downloads/inbox/app,logs}
rm -f "$DEST"/bin/*
cp -a "$KIT/agent-home/bin/." "$DEST/bin/"
chmod +x "$DEST"/bin/*.sh "$DEST"/bin/*.py
sed "s#__HOME__#$HOME#g" "$KIT/agent-home/.mcp.json" > "$DEST/.mcp.json"
# The app (its chat history and settings live in ~/.local/state/personal-agent/app, not here, so they survive updates).
rm -rf "$DEST/app.new"; cp -a "$KIT/agent-home/app" "$DEST/app.new"
[[ -d "$DEST/app/node_modules" ]] && mv "$DEST/app/node_modules" "$DEST/app.new/"
rm -rf "$DEST/app"; mv "$DEST/app.new" "$DEST/app"
cp -n "$KIT/agent-home/schedules/memory-cleanup.txt" "$DEST/schedules/" 2>/dev/null || true
# Memory skeleton: only files that don't exist yet (never overwrite what the agent learned).
for f in INDEX.md profile.md people.md pending.md sites/_TEMPLATE.md; do
    [[ -e "$DEST/memory/$f" ]] || cp "$KIT/agent-home/memory/$f" "$DEST/memory/$f"
done

# Fill in names etc. (CLAUDE.md is always regenerated; profile.md only while it still has placeholders.)
AGENT_NAME="$(env_get AGENT_NAME)" OWNER_NAME="$(env_get OWNER_NAME)" BOT_USERNAME="$(env_get BOT_USERNAME)" \
TIMEZONE="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)" \
python3 - "$KIT/agent-home/CLAUDE.md" "$DEST/CLAUDE.md" "$DEST/memory/profile.md" <<'EOF'
import os, sys
vals = {k: os.environ.get(k) or d for k, d in
        (("AGENT_NAME", "Agent"), ("OWNER_NAME", "the owner"), ("BOT_USERNAME", "your bot"), ("TIMEZONE", "unknown"))}
def fill(s):
    for k, v in vals.items():
        s = s.replace(f"__{k}__", v)
    return s
src, dst, profile = sys.argv[1:]
open(dst, "w").write(fill(open(src).read()))
p = open(profile).read()
if "__" in p:
    open(profile, "w").write(fill(p))
EOF

# settings.json: take the kit's rules, keep anything the plugin installer added.
sed "s#__HOME__#$HOME#g" "$KIT/agent-home/.claude/settings.json" > "$DEST/.claude/settings.kit.json"
if [[ -f "$DEST/.claude/settings.json" ]]; then
    jq -s '.[1] * .[0]' "$DEST/.claude/settings.kit.json" "$DEST/.claude/settings.json" > "$DEST/.claude/settings.json.new"
    mv "$DEST/.claude/settings.json.new" "$DEST/.claude/settings.json"
    rm -f "$DEST/.claude/settings.kit.json"
else
    mv "$DEST/.claude/settings.kit.json" "$DEST/.claude/settings.json"
fi

step "App: installing its parts (npm)"
( cd "$DEST/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ) || { echo "npm install for the app failed." >&2; exit 1; }

step "App: private link key"
# app.json = the owner's link token + the secret the agent's app channel uses. Made once; kept on updates.
APP_STATE="$HOME/.local/state/personal-agent/app"; mkdir -p "$APP_STATE"; chmod 700 "$APP_STATE"
[[ -s "$APP_STATE/app.json" ]] || python3 -c 'import json, secrets; print(json.dumps({"token": secrets.token_hex(24), "bridge": secrets.token_hex(24)}))' > "$APP_STATE/app.json"
chmod 600 "$APP_STATE/app.json"

step "Helper commands (~/.local/bin)"
mkdir -p "$HOME/.local/bin"
install -m 755 "$KIT/tools/transcribe" "$HOME/.local/bin/transcribe"

step "Telegram access (only your account, id $CHAT_ID, may talk to the bot)"
mkdir -p "$TG_DIR"; chmod 700 "$TG_DIR"
printf '{"dmPolicy":"allowlist","allowFrom":["%s"],"groups":{}}\n' "$CHAT_ID" > "$TG_DIR/access.json"
chmod 600 "$TG_DIR/.env" "$ENV_FILE"

step "Telegram plugin for ~/agent-home"
cd "$DEST"
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin marketplace update claude-plugins-official >/dev/null 2>&1 || true
if ! claude plugin list 2>/dev/null | grep -q 'telegram@claude-plugins-official'; then
    claude plugin install telegram@claude-plugins-official --scope project
fi
cd - >/dev/null

step "Claude Code: skip first-run screens, trust ~/agent-home"
cfg="$HOME/.claude.json"
[[ -s "$cfg" ]] || echo '{}' > "$cfg"
jq --arg p "$DEST" '.hasCompletedOnboarding = true
    | .projects[$p] = ((.projects[$p] // {}) + {hasTrustDialogAccepted: true,
                       enabledMcpjsonServers: ["browser_personal", "browser_work", "app"]})' "$cfg" > "$cfg.new" && mv "$cfg.new" "$cfg"
chmod 600 "$cfg"

step "Start with the desktop"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/personal-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Personal agent
Comment=Starts the Telegram agent and its browsers (tmux session "agent")
Exec=$DEST/bin/start-agent.sh
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
NoDisplay=true
EOF

step "Cron: nightly restart 04:00, watchdog every 5 min, weekly memory cleanup"
{ crontab -l 2>/dev/null | grep -vF '# agent-system:' || true
  echo "0 4 * * * $DEST/bin/restart-claude.sh >/dev/null 2>&1 # agent-system:nightly-restart"
  echo "*/5 * * * * $DEST/bin/watchdog.sh >/dev/null 2>&1 # agent-system:watchdog"; } | crontab -
crontab -l 2>/dev/null | grep -qF '# agent-job:memory-cleanup |' || "$DEST/bin/schedule.sh" add memory-cleanup "weekly SUN 03:17"

step "Telegram command menu"
token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$TG_DIR/.env" | tr -d "\"' \r")"
# Chat scope: the plugin resets the bot's general menu when it starts, a chat-specific menu survives that.
cmds='[{"command":"new","description":"Fresh session (memory kept)"},
       {"command":"sessions","description":"Go back to an earlier session"},
       {"command":"model","description":"Switch model (opus / sonnet / haiku)"},
       {"command":"usage","description":"Claude plan usage (5-hour / weekly)"},
       {"command":"info","description":"Health and session status"},
       {"command":"pending","description":"What is waiting on me"},
       {"command":"stop","description":"Stop the current task now"}]'
curl -fsS -o /dev/null --data-urlencode "commands=$cmds" \
     --data-urlencode "scope={\"type\":\"chat\",\"chat_id\":$CHAT_ID}" \
     "https://api.telegram.org/bot$token/setMyCommands" && echo "  menu set" || echo "  (menu not set; not critical)"

step "Agent files ready"
