#!/bin/bash
# Publish the board: build data.enc.json from a data folder, check for leaks, commit and push.
# Usage: tools/publish.sh <data_folder>
# Needs: RUNDOWN_PW (page password), RUNDOWN_API_URL and RUNDOWN_API_TOKEN (Google service),
#        RUNDOWN_LEAK (words that must never appear in plain text here, separated by |; see the handover notes).
# Works from any computer or cloud agent with git, python3 and the "cryptography" package.
set -euo pipefail
DB="$1"; REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
: "${RUNDOWN_PW:?set RUNDOWN_PW}"; : "${RUNDOWN_LEAK:?set RUNDOWN_LEAK (see handover)}"
git pull -q --rebase || true
python3 build_data.py "$DB" . "$RUNDOWN_PW"
if grep -rilE "$RUNDOWN_LEAK" . --exclude-dir=.git --exclude=CNAME; then echo "LEAK CHECK FAILED: the files above contain private words. Not publishing."; git checkout data.enc.json; exit 2; fi
git add data.enc.json
if git diff --cached --quiet; then echo "Nothing changed"; exit 0; fi
git commit -q -m "${RUNDOWN_MSG:-Update}"
echo "Committed. Now push with:  git push"
