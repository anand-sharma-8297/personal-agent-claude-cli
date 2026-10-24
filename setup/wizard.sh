#!/usr/bin/env bash
# Setup wizard: asks for everything the agent needs (Claude login, Telegram bot, your Telegram account, voice
# notes key, Tailscale), installs the rest, and starts the agent. Run again any time to update or change settings.
#   bash ~/.agent-kit/setup/wizard.sh
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.agent.env"
TG_DIR="$HOME/.claude/channels/telegram"
SECRETS="$HOME/.local/state/personal-agent/secrets"
DEST="$HOME/agent-home"
TITLE="Personal agent setup"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mSetup stopped: %s\033[0m\n' "$*" >&2; exit 1; }
quit_check() { whiptail --title "$TITLE" --yesno "Quit the setup?\n\nYou can start it again later with the same command; finished steps are kept." 10 70 && { clear; echo "Setup cancelled."; exit 0; }; }
msg()   { whiptail --title "$TITLE" --msgbox "$1" "${2:-16}" 76; }
yesno() { whiptail --title "$TITLE" --yesno "$1" "${2:-14}" 76; }
# input <text> <default> [height] → prints the answer; Cancel asks whether to quit.
input() {
    local a
    while true; do
        a="$(whiptail --title "$TITLE" --inputbox "$1" "${3:-14}" 76 "$2" 3>&1 1>&2 2>&3)" && { printf '%s' "$a" | tr -d '\r\n'; return 0; }
        quit_check
    done
}
env_get() { sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*\$/\1/p" "$ENV_FILE" 2>/dev/null | tail -n1; }
set_env() {  # set_env KEY VALUE ('' removes the key)
    local tmp; tmp="$(mktemp)"
    touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
    grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
    [[ -n "$2" ]] && printf '%s=%s\n' "$1" "$2" >> "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
tg_api() { curl -sS --max-time "${3:-20}" "https://api.telegram.org/bot$1/$2"; }
trim() { sed -E 's/^[[:space:]]+|[[:space:]]+$//g' <<<"$1"; }
has_desktop() { [[ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]] && pgrep -u "$(id -u)" -x gnome-shell >/dev/null; }

# Private https address for the app: https://<laptop>.<tailnet>.ts.net:8443 (Tailscale only). The first time on a
# Tailscale account, HTTPS must be switched on once; tailscale prints a link for that. Returns 0 when serving.
app_serve() {
    local out link
    tailscale serve status 2>/dev/null | grep -q ':8443' && return 0
    while true; do
        out="$(timeout 25 sudo tailscale serve --bg --https=8443 http://127.0.0.1:8950 2>&1)" && return 0
        tailscale serve status 2>/dev/null | grep -q ':8443' && return 0
        link="$(grep -oE 'https://login\.tailscale\.com/[^ ]+' <<<"$out" | head -n1)"
        if [[ -n "$link" ]]; then
            msg "Switch on HTTPS for your Tailscale network (one time)

The app needs a private https address. Open this link on any device signed in to the same Tailscale account and click Enable:

$link

Then press OK here." 16
        else
            yesno "Setting up the app address did not work:

$(tail -n 4 <<<"$out")

Try again?" 14 || return 1
        fi
    done
}

# ---------------------------------------------------------------- checks
[[ $EUID -ne 0 ]] || die "run this as your normal user, not root (no sudo in front)."
grep -qi '^ID=ubuntu' /etc/os-release 2>/dev/null || die "this kit supports Ubuntu Desktop only."
[[ "$(uname -m)" == x86_64 ]] || die "Google Chrome for Linux needs a 64-bit Intel/AMD laptop (x86_64)."
command -v whiptail >/dev/null || { sudo apt-get update && sudo apt-get install -y whiptail; } || die "could not install whiptail."

# ---------------------------------------------------------------- update or full setup
mode=full
if [[ -n "$(env_get TELEGRAM_CHAT_ID)" && -f "$DEST/CLAUDE.md" ]]; then
    choice="$(whiptail --title "$TITLE" --menu "$(env_get AGENT_NAME) is already installed on this laptop. What do you want to do?" 14 76 3 \
        update   "Update to the latest version (keeps all settings and memory)" \
        settings "Change settings (bot, account, model, voice, Tailscale)" \
        quit     "Nothing, exit" 3>&1 1>&2 2>&3)" || choice=quit
    case "$choice" in update) mode=update ;; settings) mode=full ;; *) clear; exit 0 ;; esac
fi

if [[ "$mode" == update ]]; then
    clear
    bash "$KIT/setup/deploy.sh" || die "updating the agent files failed (see above)."
    if ! tailscale serve status 2>/dev/null | grep -q ':8443'; then
        sudo -v && app_serve && "$DEST/bin/app-link.sh" >/dev/null 2>&1 && say "The app is ready: its link was sent to you on Telegram."
    fi
    if tmux has-session -t agent 2>/dev/null; then
        "$DEST/bin/session.sh" restart >/dev/null
        say "Updated. The agent restarts as soon as it is idle (about a minute)."
    else
        has_desktop && "$DEST/bin/start-agent.sh"
        say "Updated."
    fi
    exit 0
fi

msg "Welcome! This sets up your own personal AI agent on this laptop.

You chat with it on Telegram and in its own app on your phone; it works in two real Chrome browsers on this laptop (personal + work) and runs 24/7.

Have these ready (30-45 minutes in total):
  1. A Claude Pro or Max subscription (claude.ai)
  2. Telegram on your phone
  3. The Tailscale app on your phone (free; App Store / Play Store)
  4. Optional: a free Groq account for voice notes

Keep this laptop plugged in and on the internet." 20

# ---------------------------------------------------------------- system software (sudo)
clear
say "Installing system software. Type this laptop's password if asked."
sudo -v || die "sudo is needed to install software."
( while kill -0 $$ 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done ) &
sudo bash "$KIT/setup/system.sh" "$USER" || die "installing system software failed (see the messages above). Fix it and run the setup again."

say "Installing Claude Code"
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash || die "installing Claude Code failed."
command -v claude >/dev/null || die "Claude Code was installed but 'claude' is not on PATH."
claude --version

say "Installing Bun (runs the Telegram connection)"
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash || die "installing Bun failed."

# Stop a running agent while settings change (its Telegram poller would also swallow the hello message below).
tmux kill-session -t agent 2>/dev/null && say "Stopped the running agent; it starts again at the end."

# ---------------------------------------------------------------- Claude login
logged_in() { claude auth status 2>/dev/null | jq -e '.loggedIn == true' >/dev/null 2>&1; }
until logged_in; do
    msg "Sign in to Claude

Next, Claude Code asks you to sign in. A browser window opens: sign in with the Claude account (Pro or Max) the agent should use, and approve.

No browser? Copy the link shown in the terminal into any browser, then paste the code it gives you back into the terminal." 16
    clear
    claude auth login --claudeai
    logged_in || { yesno "The Claude sign-in did not finish. Try again?" 8 || die "Claude sign-in is needed."; }
done
acct="$(claude auth status 2>/dev/null | jq -r '.email // "?"')"

# ---------------------------------------------------------------- names
cur_name="$(env_get AGENT_NAME)"
name="$(trim "$(input "What should your agent be called?\n\n(This is how it introduces itself. You can keep the suggestion.)" "${cur_name:-Munshi Ji}")")"
[[ -n "$name" ]] || name="Munshi Ji"
set_env AGENT_NAME "$name"
default_owner="$(env_get OWNER_NAME)"; [[ -n "$default_owner" ]] || default_owner="$(getent passwd "$USER" | cut -d: -f5 | cut -d, -f1)"
owner="$(trim "$(input "Your name (so $name knows who it works for):" "$default_owner")")"
set_env OWNER_NAME "${owner:-$USER}"

# ---------------------------------------------------------------- Telegram bot
mkdir -p "$TG_DIR"; chmod 700 "$TG_DIR"
old_token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$TG_DIR/.env" 2>/dev/null | tr -d "\"' \r")"
msg "Create the Telegram bot

On your phone, in Telegram:
  1. Search for  @BotFather  (blue tick) and open it
  2. Send:  /newbot
  3. Send a display name, e.g.  $name
  4. Send a username ending in 'bot', e.g.  ${USER}_agent_bot
  5. BotFather replies with a token like  1234567890:AAH...

Next screen: paste that token. (Tip: send it to yourself on Telegram Web / WhatsApp Web on this laptop to copy it.)" 18
while true; do
    token="$(input "Paste the bot token from BotFather:" "$old_token")"
    token="$(tr -d " \"'" <<<"$token")"
    me="$(tg_api "$token" getMe 2>/dev/null)"
    if jq -e '.ok == true' >/dev/null 2>&1 <<<"$me"; then
        bot="$(jq -r '.result.username' <<<"$me")"; break
    fi
    msg "Telegram did not accept this token. Check you copied all of it (numbers, colon, letters) and try again." 9
done
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" > "$TG_DIR/.env"; chmod 600 "$TG_DIR/.env"
set_env BOT_USERNAME "$bot"
tg_api "$token" deleteWebhook >/dev/null 2>&1

# ---------------------------------------------------------------- your Telegram account
chat_id="$(env_get TELEGRAM_CHAT_ID)"
if [[ -n "$chat_id" && "$token" == "$old_token" ]] && yesno "Keep the same Telegram account (id $chat_id) as the only one allowed to use @$bot?" 9; then
    :
else
    chat_id=''
    while [[ -z "$chat_id" ]]; do
        msg "Connect your Telegram account

On your phone, open Telegram, search for  @$bot , open it and tap START (or send 'hi').

Then press OK here. Only your account will be allowed to talk to the bot." 13
        whiptail --title "$TITLE" --infobox "Waiting for your message to @$bot ..." 7 60
        found=''
        for _ in 1 2 3; do
            upd="$(tg_api "$token" 'getUpdates?timeout=25&allowed_updates=%5B%22message%22%5D' 35)"
            found="$(jq -c '[.result[]? | select(.message.chat.type == "private")] | last
                            | select(. != null) | {u: .update_id, id: .message.from.id, n: ((.message.from.first_name // "") + " " + (.message.from.last_name // "")), user: (.message.from.username // "")}' <<<"$upd" 2>/dev/null)"
            [[ -n "$found" ]] && break
        done
        if [[ -n "$found" ]]; then
            id="$(jq -r .id <<<"$found")"; who="$(trim "$(jq -r .n <<<"$found")")"; user="$(jq -r .user <<<"$found")"
            tg_api "$token" "getUpdates?offset=$(( $(jq -r .u <<<"$found") + 1 ))&timeout=0" >/dev/null 2>&1   # mark as read
            if yesno "Got a message from:\n\n    $who ${user:+(@$user)}\n    Telegram id $id\n\nIs this you?" 12; then
                chat_id="$id"
            fi
        else
            yesno "No message arrived yet. Did you tap START in @$bot ?\n\nYes = wait again   ·   No = type your Telegram id by hand" 11 ||
                chat_id="$(input "Your numeric Telegram id (e.g. from @userinfobot):" "")"
        fi
        [[ "$chat_id" =~ ^[0-9]+$ ]] || chat_id=''
    done
fi
set_env TELEGRAM_CHAT_ID "$chat_id"

# ---------------------------------------------------------------- model
cur_model="$(env_get AGENT_MODEL)"; cur_model="${cur_model:-sonnet}"
pick() { [[ "$cur_model" == "$1" ]] && echo ON || echo OFF; }
model="$(whiptail --title "$TITLE" --radiolist "Which Claude model should $name use? (Change any time with /model in Telegram.)" 15 76 3 \
    sonnet  "Sonnet - fast, lasts much longer on a Pro plan (recommended)" "$(pick sonnet)" \
    opus    "Opus - strongest; best with a Max plan" "$(pick opus)" \
    default "Account default" "$(pick default)" 3>&1 1>&2 2>&3)" || model="$cur_model"
[[ "$model" == default ]] && set_env AGENT_MODEL '' || set_env AGENT_MODEL "$model"

# ---------------------------------------------------------------- voice notes (optional)
mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
old_groq="$(sed -n 's/^GROQ_API_KEY=//p' "$SECRETS/groq.env" 2>/dev/null)"
if yesno "Voice notes (optional)

$name can understand Telegram voice notes (Hindi, English, Hinglish). This needs a free Groq API key:
  1. Open  console.groq.com/keys  and sign in (Google works)
  2. Create API key, copy it

Set up voice notes now?$( [[ -n "$old_groq" ]] && printf '\n\n(A key is already saved; choose Yes to replace it, No to keep it.)')" 17; then
    while true; do
        groq="$(tr -d " \"'" <<<"$(input "Paste the Groq API key (starts with gsk_):" "")")"
        [[ -z "$groq" ]] && break
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $groq" https://api.groq.com/openai/v1/models)"
        if [[ "$code" == 200 ]]; then
            printf 'GROQ_API_KEY=%s\n' "$groq" > "$SECRETS/groq.env"; chmod 600 "$SECRETS/groq.env"; break
        fi
        yesno "Groq did not accept this key (HTTP $code). Try again?" 8 || break
    done
fi

# ---------------------------------------------------------------- Tailscale
ts_ip() { tailscale ip -4 2>/dev/null | head -n1; }
if [[ -z "$(ts_ip)" ]]; then
    msg "Tailscale (private network between your phone and this laptop)

$name sends you links to watch its browser live and to sign in to websites from your phone. They only open over Tailscale, so nobody else can reach them.

  1. On your phone: install Tailscale and sign in (Google is easiest)
  2. Next, the terminal shows a link and a QR code: open it (scan the QR with your phone camera) and sign in with the SAME account, then approve this laptop." 18
    clear
    say "Connecting this laptop to Tailscale: open the link / scan the QR code below and sign in."
    until sudo tailscale up --qr --timeout=15m && [[ -n "$(ts_ip)" ]]; do
        yesno "Tailscale did not connect. Try again?" 8 || die "Tailscale is needed for the live view and phone logins. Run the setup again when ready."
        clear
    done
fi
set_env AGENT_LOGIN_HELPER 1

# ---------------------------------------------------------------- install the agent
clear
bash "$KIT/setup/deploy.sh" || die "setting up the agent files failed (see above)."

# ---------------------------------------------------------------- start
if ! has_desktop; then
    clear
    say "All set. The agent starts when this laptop's desktop starts: reboot it now (sudo reboot)."
    say "Then say hi to @$bot on Telegram."
    exit 0
fi
say "Starting $name (first start downloads the browser tools; up to 3 minutes)"
"$DEST/bin/start-agent.sh"
connected=false
for ((i = 0; i < 90; i++)); do
    if pgrep -u "$(id -u)" -f 'bun.*server\.ts' >/dev/null; then connected=true; break; fi
    sleep 2
done
if $connected; then
    sleep 5
    "$DEST/bin/notify.sh" --telegram "👋 Hi $(env_get OWNER_NAME)! I'm $name, your personal agent, and I'm ready.
Try: \"Open google.com in the personal browser and send me a screenshot.\"
Menu (/) has /new /model /usage /info and more." || true
else
    tmux capture-pane -p -t agent:claude 2>/dev/null | tail -n 25 > /tmp/agent-start.txt
    msg "$name started but its Telegram connection is not up yet.

It may be waiting on a question in its window. Open a terminal and run:
    tmux attach -t agent
(Ctrl-b then d to leave.) Screen saved in /tmp/agent-start.txt.
The watchdog also retries every 5 minutes." 14
fi

# ---------------------------------------------------------------- the app (after Telegram works)
app_ok=false
if $connected; then
    msg "Your $name app

Besides Telegram, $name has its own chat app for your phone: answers with tables and charts, live steps while it works, and notifications for alerts.

Next: the app gets a private address on your Tailscale network, and its link is sent to you on Telegram." 14
    clear
    if app_serve; then
        for _ in $(seq 20); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:8950/ && break; sleep 1; done
        if url="$("$DEST/bin/app-link.sh" --print 2>/dev/null)" && "$DEST/bin/app-link.sh" >/dev/null 2>&1; then
            app_ok=true
            clear
            say "Your app link (also sent to you on Telegram). Scan with your phone camera, or tap the link in Telegram:"
            qrencode -t ANSIUTF8 "$url" 2>/dev/null || true
            msg "Install the app on your phone

The link is in your Telegram chat with @$bot (keep it private). Make sure Tailscale is ON on the phone, then:

  • iPhone (Safari): open the link → Share → Add to Home Screen, then open it from the Home Screen
  • Android (Chrome): open the link → ⋮ → Install app

In the app: menu (•••) → Turn on notifications. Alerts then come to the app first (Telegram is the backup).

If the page won't load on iPhone: Tailscale app → Settings → turn on 'Use Tailscale DNS'.
Lost the link later? Ask $name for your \"app link\"." 22
        fi
    fi
    $app_ok || msg "The app could not be set up right now; Telegram works as normal. Run the setup again later (choose Update) to finish the app." 10
fi

msg "Done! 🎉  $name is running.

  • Telegram: @$bot  (only your account can use it)
  • App: $($app_ok && echo "link sent on Telegram" || echo "not set up yet (run the setup again → Update)")
  • Claude account: $acct
  • Two Chrome windows opened: AGENT PERSONAL BROWSER and AGENT WORK BROWSER. Sign in to your Google (and other) accounts there now, or later from your phone via the links $name sends.

Good to know:
  • Reboot once to check it starts by itself
  • Watch it work:  tmux attach -t agent
  • Update / change settings: run the install command again
  • Use Claude yourself here:  ~/agent-home/bin/claude-admin.sh" 22
clear
say "$name is running. Say hi to @$bot on Telegram."
