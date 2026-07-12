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
 * Expects an Airtable table named "Partners" with fields:
 *   Name    (single line text)
 *   Slug    (single line text, e.g. "fairhaven-gallery")
 *   Status  (single select, must include "Confirmed" and "QR Generated")
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';
const TABLE_NAME = 'Partners';
const REDIRECT_BASE = 'https://join.jessicaclark.travel/partner';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DEFAULT_COLOR = '#000000';

function parseColorFlag(argv) {
  const flag = argv.find((arg) => arg.startsWith('--color='));
  return flag ? flag.split('=')[1] : DEFAULT_COLOR;
}

async function fetchPartnerRows(apiKey, baseId) {
  const rows = [];
  let offset;

  do {
    const url = new URL(
      `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(TABLE_NAME)}`
    );
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
  const url = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(TABLE_NAME)}/${recordId}`;

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

  console.log(`Fetching rows from "${TABLE_NAME}"...`);
  const rows = await fetchPartnerRows(apiKey, baseId);

  let generated = 0;
  let skippedDone = 0;
  let skippedNotConfirmed = 0;

  for (const row of rows) {
    const fields = row.fields || {};

    if (!('Slug' in fields) || !('Status' in fields)) {
      console.error(
        `Row ${row.id} is missing a "Slug" or "Status" field — check for a renamed or missing column in Airtable. Skipping this row (not counted in the summary).`
      );
      continue;
    }

    const { Slug: slug, Status: status, Name: name } = fields;

    if (status === 'QR Generated') {
      skippedDone += 1;
      continue;
    }

    if (status !== 'Confirmed') {
      skippedNotConfirmed += 1;
      continue;
    }

    if (!slug) {
      console.error(
        `Row ${row.id} (${name || 'unnamed'}) has Status "Confirmed" but no Slug set — skipping.`
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
  console.log(`  Not confirmed:  ${skippedNotConfirmed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
