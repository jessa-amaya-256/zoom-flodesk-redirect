#!/usr/bin/env node
/**
 * scripts/generate-qr-codes.js
 *
 * LOCAL-ONLY. Not deployed to Vercel — run this from your own machine.
 *
 * Pulls confirmed B2B partners from Airtable, generates a print-ready
 * SVG QR code for each one pointing at that partner's
 * join.jessicaclark.travel redirect slug, and marks each row as done
 * in Airtable so reruns only touch new confirmations.
 *
 * Usage:
 *   npm run generate-qr
 *   node scripts/generate-qr-codes.js
 *   node scripts/generate-qr-codes.js --color=#4C4F4A
 *
 * Requires env vars (e.g. in a local .env you load yourself, or export
 * directly in your shell):
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *
 * Targets the Partners table BY TABLE ID (tblFlH8ssP07XdrhZ), not by
 * name. Names are mutable — there is already a "Partners (legacy)"
 * archive table one rename away from being the thing this script
 * PATCHes. Table IDs are immutable.
 *
 * Expects these fields on that table:
 *   Name    (single line text)
 *   Slug    (single line text, e.g. "fairhaven-gallery")
 *   Status  (single select, must include "Confirmed" and "QR Generated")
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';
const BASE_ID = 'appv81raB2A2g9x1Y'; // Not a secret. Only the PAT is.
const TABLE_ID = 'tblFlH8ssP07XdrhZ'; // Partners — immutable ID, do not swap for the name
const REDIRECT_BASE = 'https://join.jessicaclark.travel/partner';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DEFAULT_COLOR = '#000000';

// Only pull what we use. Without this, every row drags along Legacy Intro
// (Archive), Specific Detail, Notes and the QR Code Preview attachment
// blob — a payload many times larger than this script has any use for.
const FIELDS = ['Name', 'Slug', 'Status'];

function parseColorFlag(argv) {
  const flag = argv.find((arg) => arg.startsWith('--color='));
  return flag ? flag.split('=')[1] : DEFAULT_COLOR;
}

async function fetchPartnerRows(apiKey, baseId) {
  const rows = [];
  let offset;

  do {
    const url = new URL(`${AIRTABLE_API_BASE}/${baseId}/${TABLE_ID}`);
    for (const field of FIELDS) {
      url.searchParams.append('fields[]', field);
    }
    if (offset) url.searchParams.set('offset', offset);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Airtable list request failed: ${response.status} ${body}`);
    }

    const data = await response.json();
    rows.push(...data.records);
    offset = data.offset;
  } while (offset);

  return rows;
}

async function markRowGenerated(apiKey, baseId, recordId) {
  const url = `${AIRTABLE_API_BASE}/${baseId}/${TABLE_ID}/${recordId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { Status: 'QR Generated' } }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable update failed for ${recordId}: ${response.status} ${body}`);
  }
}

async function main() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!apiKey || !baseId) {
    console.error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID in environment.');
    process.exit(1);
  }

  const color = parseColorFlag(process.argv.slice(2));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Fetching rows from ${TABLE_ID} (Partners)...`);
  const rows = await fetchPartnerRows(apiKey, baseId);

  // Schema check, done ONCE against the whole result set rather than
  // per row. Airtable omits empty cells from the API response entirely
  // — it does not return them as null — so a single row missing "Slug"
  // means an empty cell, NOT a renamed column. Only if NO row in the
  // table has the key can we conclude the column is actually gone.
  if (rows.length > 0) {
    for (const field of ['Slug', 'Status']) {
      const presentSomewhere = rows.some((row) => field in (row.fields || {}));
      if (!presentSomewhere) {
        console.error(
          `No row in the table has a "${field}" field. That column has likely been renamed or deleted in Airtable. Aborting rather than guessing.`
        );
        process.exit(1);
      }
    }
  }

  let generated = 0;
  let skippedDone = 0;
  let skippedNoStatus = 0;
  const statusCounts = {}; // tally of every non-Confirmed, non-QR-Generated status seen

  for (const row of rows) {
    const fields = row.fields || {};
    const { Slug: slug, Status: status, Name: name } = fields;

    if (!status) {
      // Empty Status cell — a partner that hasn't been triaged yet.
      // Normal, not an error.
      skippedNoStatus += 1;
      continue;
    }

    if (status === 'QR Generated') {
      skippedDone += 1;
      continue;
    }

    if (status !== 'Confirmed') {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      continue;
    }

    if (!slug) {
      console.error(
        `Row ${row.id} (${name || 'unnamed'}) has Status "Confirmed" but an empty Slug cell — skipping. Set a slug in Airtable and rerun.`
      );
      continue;
    }

    const targetUrl = `${REDIRECT_BASE}/${slug}`;
    const outputPath = path.join(OUTPUT_DIR, `qr-${slug}.svg`);

    const svg = await QRCode.toString(targetUrl, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: 1,
      color: {
        dark: color,
        light: '#ffffff00', // transparent — no printed background box
      },
    });

    fs.writeFileSync(outputPath, svg, 'utf8');
    await markRowGenerated(apiKey, baseId, row.id);

    console.log(`Generated ${outputPath} (${name || slug})`);
    generated += 1;
  }

  console.log('\nSummary:');
  console.log(`  Generated:      ${generated}`);
  console.log(`  Already done:   ${skippedDone}`);
  console.log(`  No status set:  ${skippedNoStatus}`);
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status}:`.padEnd(18) + count);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
