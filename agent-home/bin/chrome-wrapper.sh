#!/usr/bin/env bash
# Launches Google Chrome for the agent browsers (Playwright's executablePath points here).
# Before starting, it removes download-history entries whose file no longer exists. Playwright saves
# downloads to temporary folders that are deleted afterwards, and Chrome 154 segfaults when a new
# download starts while such stale entries are in the history (found 2026-10-08).
profile=''
for a in "$@"; do [[ "$a" == --user-data-dir=* ]] && profile="${a#--user-data-dir=}"; done
if [[ -n "$profile" && -f "$profile/Default/History" ]]; then
    python3 - "$profile/Default/History" <<'EOF' 2>/dev/null || true
import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=2)
ids = [i for i, p in db.execute("SELECT id, target_path FROM downloads") if not p or not os.path.exists(p)]
for i in ids:
    for table in ("downloads", "downloads_url_chains", "downloads_slices"):
        try:
            db.execute(f"DELETE FROM {table} WHERE id = ?", (i,))
        except sqlite3.OperationalError:
            pass
db.commit()
EOF
fi
exec /opt/google/chrome/chrome "$@"
