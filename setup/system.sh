#!/usr/bin/env bash
# System part of the install. Run by the wizard as root (sudo bash setup/system.sh <user>); safe to run again.
# Installs the tools, Node.js, Google Chrome and Tailscale, logs <user> in automatically at boot, and stops the
# laptop from sleeping (also with the lid closed), so the agent keeps running. Also gives <user> passwordless sudo,
# so the agent can install software itself (its rules make it ask on Telegram first).
set -euo pipefail

USER_NAME="${1:-${SUDO_USER:-}}"
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -n "$USER_NAME" && "$USER_NAME" != root ]] || { echo "Usage: sudo bash $0 <username>" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
MARK=/var/lib/agent-kit
mkdir -p "$MARK"

step "Updating the package list"
apt-get update

if [[ ! -f "$MARK/upgraded" ]]; then
    step "Installing Ubuntu updates (first install only; can take 5-20 min)"
    apt-get -y upgrade
    touch "$MARK/upgraded"
fi

step "Installing tools"
apt-get install -y tmux curl git jq unzip ca-certificates gnupg cron python3 whiptail qrencode

if ! command -v gnome-shell >/dev/null; then
    step "Installing a desktop (the agent's Chrome windows need one; 15-30 min)"
    apt-get install -y ubuntu-desktop-minimal
fi

node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z "$node_major" || "$node_major" -lt 20 ]]; then
    step "Installing Node.js LTS"
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
fi
node --version

if ! command -v google-chrome >/dev/null; then
    step "Installing Google Chrome"
    curl -fsSLo /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
fi
google-chrome --version

if ! command -v tailscale >/dev/null; then
    step "Installing Tailscale"
    curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled >/dev/null 2>&1 || true

step "Automatic login as $USER_NAME (the agent starts with the desktop)"
conf=/etc/gdm3/custom.conf
if [[ -f "$conf" ]]; then
    sed -i '/^[#[:space:]]*AutomaticLogin\(Enable\)\?[[:space:]]*=/d' "$conf"
    grep -q '^\[daemon\]' "$conf" || printf '\n[daemon]\n' >> "$conf"
    sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=$USER_NAME" "$conf"
else
    echo "  (no $conf: turn on automatic login in Settings > Users yourself)"
fi

step "Never sleep, keep running with the lid closed"
# A drop-in works whether or not /etc/systemd/logind.conf exists (newer Ubuntu ships it only under /usr).
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/agent-no-sleep.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
EOF
systemctl kill -s HUP systemd-logind 2>/dev/null || true   # reload the lid setting now, without logging anyone out
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target >/dev/null
# Desktop defaults for every user: no automatic suspend, no screen lock (start-agent.sh also sets these at login).
mkdir -p /etc/dconf/db/local.d /etc/dconf/profile
[[ -f /etc/dconf/profile/user ]] || printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
cat > /etc/dconf/db/local.d/00-agent-power <<'EOF'
[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'

[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false
EOF
command -v dconf >/dev/null && dconf update

step "Passwordless sudo for $USER_NAME (the agent installs software itself, after your Yes on Telegram)"
rule="/etc/sudoers.d/agent-nopasswd"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USER_NAME" > "$rule.tmp"
chmod 440 "$rule.tmp"
if visudo -cf "$rule.tmp" >/dev/null; then mv "$rule.tmp" "$rule"; else rm -f "$rule.tmp"; echo "  (sudoers check failed; skipped)"; fi

step "Cron (runs the watchdog and scheduled jobs)"
systemctl enable --now cron

step "System part done"
