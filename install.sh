#!/usr/bin/env bash
# One-command installer for the personal agent. On a fresh Ubuntu Desktop laptop, open a terminal and run:
#   curl -fsSL https://raw.githubusercontent.com/anand-sharma-8297/personal-agent-claude-cli/main/install.sh | bash
# Downloads the kit to ~/.agent-kit and opens the setup wizard. Run the same command again to update.
set -euo pipefail

main() {
    local repo="${AGENT_KIT_REPO:-anand-sharma-8297/personal-agent-claude-cli}" branch="${AGENT_KIT_BRANCH:-main}"
    local kit="$HOME/.agent-kit" tmp
    [[ $EUID -ne 0 ]] || { echo "Run this as your normal user (without sudo)." >&2; exit 1; }
    command -v curl >/dev/null || { echo "curl is missing: sudo apt install -y curl" >&2; exit 1; }
    echo "Downloading the agent kit ($repo@$branch)..."
    tmp="$(mktemp -d)"
    curl -fsSL "https://codeload.github.com/$repo/tar.gz/refs/heads/$branch" | tar -xz -C "$tmp" --strip-components=1
    [[ -f "$tmp/setup/wizard.sh" ]] || { echo "Download looks broken (no setup/wizard.sh)." >&2; exit 1; }
    rm -rf "$kit"; mv "$tmp" "$kit"
    # The wizard is interactive: read the keyboard, not this piped script.
    exec bash "$kit/setup/wizard.sh" < /dev/tty
}

main "$@"
