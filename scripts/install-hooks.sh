#!/bin/sh
# install-hooks.sh - turn on the repo's git hooks (this repo only).
set -e
top=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$top"
if [ ! -d .git ]; then
    echo "install-hooks: $top is not a git repo root" >&2
    exit 1
fi
git config core.hooksPath githooks
chmod +x githooks/pre-push scripts/privacy-check.sh scripts/install-hooks.sh
echo "Set core.hooksPath=githooks in $top/.git/config (this repo only)."
echo "Made githooks/pre-push, scripts/privacy-check.sh and scripts/install-hooks.sh executable."
echo "Every git push now runs the privacy check first. Run it by hand: scripts/privacy-check.sh"
