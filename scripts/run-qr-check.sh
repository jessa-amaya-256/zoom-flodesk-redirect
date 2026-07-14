#!/bin/bash
#
# scripts/run-qr-check.sh
#
# One-command shortcut for checking the Partners table for new confirmations
# and generating QR codes for any that are ready. Safe to run anytime —
# weekly, or right after a partner says yes.

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo ""
echo "Checking in on partner outreach..."
echo ""

# Load credentials from .env.
#
# NOT `export $(grep -v '^#' .env | xargs)` — that word-splits on whitespace,
# so any value containing a space (a From: name, a multi-word label) gets
# mangled into bogus assignments and, under `set -e`, kills the script.
# `set -a` + `source` uses real shell parsing: quotes and spaces survive.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

if [ -z "$AIRTABLE_API_KEY" ]; then
  echo "AIRTABLE_API_KEY isn't set."
  echo "Add it to a .env file in this repo's root (see .env.example)."
  exit 1
fi

# Warn rather than die. A dirty working tree or a missing upstream shouldn't
# stop you from checking which partners are waiting on a QR code.
echo "Pulling latest code..."
if ! git pull --quiet 2>/dev/null; then
  echo "  (couldn't pull — uncommitted changes or no upstream. Continuing with local code.)"
fi

echo ""
npm run generate-qr

echo ""
echo "Done. Any new QR codes are in /output, ready to send to print."
echo "Check the summary above — anything not yet Confirmed is still waiting on you."
echo ""
