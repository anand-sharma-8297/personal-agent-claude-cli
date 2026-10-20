#!/usr/bin/env bash
# Runs one Playwright MCP server for one of the agent's browsers (personal or work), restarting it if it exits.
#   start-browser.sh personal|work
# Each browser is a real, headed Chrome with its own persistent profile, so logins stay separate.
# The main Telegram session and scheduled jobs share the same server per browser, so they never fight
# over a profile lock. Chrome also gets a DevTools port on 127.0.0.1 only (used by the optional login helper).
set -uo pipefail
. "$(dirname "$0")/common.sh"
name="${1:-}"
[[ -n "${BROWSER_PORT[$name]:-}" ]] || { echo "Usage: $0 personal|work" >&2; exit 1; }
port=${BROWSER_PORT[$name]}
printf '\033]2;Agent - Browser (%s)\007' "$name"

# chrome-wrapper.sh clears stale download-history entries first (they make Chrome crash on downloads).
# --password-store=basic: with autologin the GNOME keyring stays locked, and Chrome would otherwise wait
# on an "unlock keyring" dialog that nobody is there to answer.
config="$STATE_DIR/playwright-$name.json"
jq -n --arg profile "${BROWSER_PROFILE[$name]}" --arg cdp "${BROWSER_CDP[$name]}" \
      --arg label "${BROWSER_LABEL[$name]}" --arg out "$AGENT_HOME/downloads" \
      --arg exe "$BIN_DIR/chrome-wrapper.sh" '{
    browser: {
        browserName: "chromium",
        userDataDir: $profile,
        launchOptions: {
            channel: "chrome",
            executablePath: $exe,
            args: ["--remote-debugging-port=\($cdp)", "--remote-debugging-address=127.0.0.1",
                   "--window-name=AGENT \($label) BROWSER", "--password-store=basic"]
        },
        contextOptions: { viewport: { width: 1440, height: 900 } }
    },
    sharedBrowserContext: true,
    outputDir: $out
}' > "$config"

while true; do
    log "browser-$name" 'starting Playwright MCP server'
    npx -y '@playwright/mcp@latest' \
        --config "$config" \
        --host 127.0.0.1 \
        --allowed-hosts "127.0.0.1:$port,localhost:$port" \
        --port "$port" 2>&1 | tee -a "$LOG_DIR/browser-$name.log"
    log "browser-$name" "server exited with code ${PIPESTATUS[0]}; restarting in 5s"
    sleep 5
done
