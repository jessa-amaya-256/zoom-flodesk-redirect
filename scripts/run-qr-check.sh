#!/bin/bash
#
# scripts/run-qr-check.sh
#
# One-command shortcut for checking the Partners table for new confirmations
# and generating QR codes for any that are ready. Safe to run anytime —
# weekly, or right after a partner says yes. Pulls the latest code first,
# so you're always running the current version of the script, and loads
# AIRTABLE_API_KEY / AIRTABLE_BASE_ID from a local .env file so you don't
# have to `export` them by hand in every new terminal session.

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo ""
echo "👋 Hey Jess — checking in on partner outreach..."
echo ""

# Load credentials from .env if present.
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$AIRTABLE_API_KEY" ] || [ -z "$AIRTABLE_BASE_ID" ]; then
  echo "⚠️  AIRTABLE_API_KEY or AIRTABLE_BASE_ID isn't set."
  echo "   Add them to a .env file in this repo's root (see .env.example),"
  echo "   or export them manually before running this again."
  exit 1
fi

echo "Pulling latest code..."
git pull --quiet

echo ""
npm run generate-qr

echo ""
echo "✅ Done. Any new QR codes are in /output, ready to send to print."
echo "   Check the summary above — anything still \"Not Contacted\" is still waiting on you."
echo ""
