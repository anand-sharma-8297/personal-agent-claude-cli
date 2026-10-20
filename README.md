# Personal agent kit

Your own 24/7 personal AI agent on a spare laptop. You chat with it on **Telegram**, and it does the work with
**Claude Code** (on your own Claude subscription) and **two real Chrome browsers** on the laptop: a personal one and
a work one, each with its own logins.

What it can do:
- Browse and work on websites for you: read, search, fill in, download, take screenshots (it asks before anything
  irreversible, like sending, buying or deleting)
- Send you a **live view** link to watch (and tap into) its browser from your phone
- Let you **sign in to websites from your phone** (your password never goes through Telegram or the AI)
- Understand **voice notes** (Hindi / English / Hinglish, optional)
- Run **scheduled jobs** ("every weekday at 9:05, check X and send me Y")
- Remember your preferences and how each website works (`memory/`)
- Telegram extras: tap-to-answer buttons, a live "working…" step feed, a pinned status and usage bar, and menu commands
  `/new /sessions /model /usage /info /pending /stop`
- Look after itself: it restarts if it crashes, starts a fresh session every night, and comes back after a reboot

## What you need
- A spare **64-bit laptop** with **Ubuntu Desktop 24.04 or newer** installed (wipe and install; ~8 GB RAM is enough)
- A **Claude Pro or Max** subscription (Max if you'll use it heavily)
- **Telegram** on your phone
- The **Tailscale** app on your phone (free)
- Optional: a free **Groq** account for voice notes

## Install (one command)
On the laptop, sign in to the desktop, open **Terminal** and run:

```bash
curl -fsSL https://raw.githubusercontent.com/anand-sharma-8297/personal-agent-claude-cli/main/install.sh | bash
```

The setup wizard walks you through everything, about 30-45 minutes in total:
1. Installs the software: Chrome, Node.js, Tailscale, Claude Code and the rest. Type the laptop password once.
2. Claude sign-in (a browser opens)
3. Name your agent
4. Create a Telegram bot with @BotFather and paste its token. It's checked straight away.
5. Tap **Start** in your new bot. The wizard picks up your Telegram account by itself, and only you can use the bot.
6. Pick a model (Sonnet / Opus)
7. Voice notes: paste a Groq key (optional)
8. Tailscale: scan the QR code with your phone
9. The agent starts and says hi on Telegram 👋

Then sign in to your accounts (Google etc.) in the two Chrome windows titled **AGENT PERSONAL BROWSER** and
**AGENT WORK BROWSER**, or later from your phone when the agent sends you a login link. Reboot once to check that it
starts by itself.

## Using it
Just message your bot. Examples:
- "Open my Gmail in the personal browser and summarise unread mails from today."
- "Find 3 flights Delhi → Mumbai next Friday evening under ₹6000, send screenshots."
- "Every Monday 9:07, check the top tech news and send me 5 bullet points."
- Send **STOP** to cancel whatever it is doing.

## Operating it
| Need | Do |
|---|---|
| Update to the latest version, or change settings | Run the install command again |
| Watch it work on the laptop | `tmux attach -t agent` (switch windows `Ctrl-b n`, leave `Ctrl-b d`) |
| Restart it | Telegram `/restart`, or `~/agent-home/bin/session.sh restart` |
| Use Claude Code yourself on that laptop | `~/agent-home/bin/claude-admin.sh` (**not** plain `claude`: that steals the Telegram connection) |
| Scheduled jobs | Ask the agent, or `~/agent-home/bin/schedule.sh list` |
| Logs | `~/agent-home/logs/` |
| Stop / remove | `bash ~/.agent-kit/setup/uninstall.sh` (keeps your data) |

## Troubleshooting
| Symptom | Fix |
|---|---|
| Bot doesn't answer | `tmux attach -t agent`, look at the `claude` window. The watchdog restarts it within 5 minutes. |
| Bot stopped answering after you ran `claude` | A second Telegram poller took over. Close it and run `~/agent-home/bin/restart-claude.sh` |
| "Browser tools missing" | A browser window was closed. Send `/restart` |
| Live view / login links don't open | Turn Tailscale ON on your phone (same account as the laptop) |
| Running out of Claude usage | `/model sonnet`, and check `/usage` |

## Privacy
Everything runs on your own laptop under your own accounts. Your bot only answers your Telegram account. Secrets
(bot token, Groq key) stay on the laptop in files only you can read, and the agent is not allowed to read them.
