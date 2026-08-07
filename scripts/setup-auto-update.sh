#!/bin/bash
# One-time setup: makes every new terminal tab you open in this Codespace
# automatically run `npm run update` (pull latest + restart the server), so
# you don't have to type it yourself. Run this once:
#
#   bash scripts/setup-auto-update.sh
#
# It edits ~/.bashrc, which lives outside this repo (in your Codespace's
# home directory) -- that's why this can't just be committed as a file.
# It survives stopping/restarting this Codespace, but a brand-new Codespace
# (or a rebuild that resets the home directory) would need this re-run.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# >>> infiniscroll auto-update >>>"

if grep -qF "$MARKER" ~/.bashrc 2>/dev/null; then
  echo "Already set up (found an existing entry in ~/.bashrc). Nothing to do."
  exit 0
fi

cat >> ~/.bashrc <<EOF

$MARKER
# Every new interactive shell in this Codespace pulls the latest code and
# restarts InfiniScroll. Guarded by INFINISCROLL_AUTO_UPDATED so it only
# runs once per terminal tab, not on every nested subshell.
if [ -d "$REPO_DIR" ] && [ -z "\$INFINISCROLL_AUTO_UPDATED" ]; then
  export INFINISCROLL_AUTO_UPDATED=1
  (cd "$REPO_DIR" && npm run update)
fi
# <<< infiniscroll auto-update <<<
EOF

echo "Done. Open a new terminal tab to see it run (or: source ~/.bashrc)."
