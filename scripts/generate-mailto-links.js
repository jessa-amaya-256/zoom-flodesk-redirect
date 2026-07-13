#!/usr/bin/env node
/**
 * generate-mailto-links.js
 *
 * Fills in the "Mailto Link" field on Partners records in Airtable, using
 * Node's built-in encodeURIComponent() — not Airtable's own formula engine.
 *
 * Why this exists: Airtable's formula language has no CHAR() function, and
 * its ENCODE_URL_COMPONENT() doesn't reliably escape '+' (it leaks through
 * as a literal '+', which Gmail's mailto parser then reads as a space —
 * this is exactly the bug that broke "R+M Dessert Bar" and the "+" in every
 * subject line). This script sidesteps both issues entirely.
 *
 * USAGE
 * -----
 *   node scripts/generate-mailto-links.js            # only fills in blank Mailto Link rows
 *   node scripts/generate-mailto-links.js --all       # regenerates every row (use after editing
 *                                                      # the EMAIL TEMPLATE section below for a new event)
 *
 * Or, once wired into package.json ("mailto": "node scripts/generate-mailto-links.js"):
 *   npm run mailto
 *   npm run mailto -- --all
 *
 * SETUP (one-time)
 * -----------------
 * 1. Get an Airtable Personal Access Token: https://airtable.com/create/tokens
 *      - Scopes: data.records:read, data.records:write
 *      - Access: add the "Private Virtual Preview - Events" base specifically
 * 2. Add it to your shell (zsh):
 *      echo 'export AIRTABLE_API_KEY="pat_your_token_here"' >> ~/.zshrc
 *      source ~/.zshrc
 *
 * REQUIREMENTS FOR A ROW TO BE PROCESSED
 * ----------------------------------------
 * Each record needs Name, Subject Line, and Intro Paragraph filled in already
 * (Email can be blank — the link will just open with no recipient pre-filled).
 * Rows missing any of those three are skipped and listed at the end.
 */

const fs = require("fs");
const path = require("path");

// Plain `node` does not load .env files on its own — this reads the repo's
// root .env file (same one .env.example documents) so AIRTABLE_API_KEY can
// live there instead of requiring a manual `export` every session. Real
// shell-exported env vars still take priority over anything in .env.
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env"); // scripts/../.env = repo root
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const BASE_ID = "appv81raB2A2g9x1Y";
const TABLE_ID = "tblUO05tbzi65COsl"; // Partners
const API_ROOT = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;

const TOKEN = process.env.AIRTABLE_API_KEY;
if (!TOKEN) {
  console.error(
    "AIRTABLE_API_KEY is not set. Add a line to your .env file in the repo root:\n" +
    "  AIRTABLE_API_KEY=pat_your_token_here\n" +
    "(See the SETUP section at the top of this file for how to generate one.)"
  );
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

// =============================================================================
// EMAIL TEMPLATE — edit this block when you reuse the script for a new event
// (e.g. Virgin Voyages outreach). `name` and `intro` are the only variables
// available; everything else is literal text.
// =============================================================================
function buildBody(name, intro) {
  const parts = [
    "Hi there,",
    intro,
    `I'm a local queer business owner myself, and a luxury travel advisor ` +
      `specializing in queer & allied travel — always looking for ways to ` +
      `champion other small businesses doing it right, ${name} included.`,
    `I'm hosting a Private Virtual Preview on Tuesday, September 22nd with ` +
      `Celebrity Cruises — the first of a monthly series, this one exploring ` +
      `Alaska. I'd love to swap support: I recommend ${name} to my clients ` +
      `every chance I get, and in return — whatever's easiest on your end — ` +
      `a small QR display for your counter, a mention in your newsletter, ` +
      `or a shared social post.`,
    "Open to a quick coffee sometime to compare notes?",
  ];
  return parts.join("\r\n\r\n");
}
// =============================================================================

function buildMailto(email, subject, name, intro) {
  const body = buildBody(name, intro);
  const qSubject = encodeURIComponent(subject);
  const qBody = encodeURIComponent(body);
  return `mailto:${email || ""}?subject=${qSubject}&body=${qBody}`;
}

async function fetchAllRecords() {
  const records = [];
  let offset;
  do {
    const url = offset ? `${API_ROOT}?offset=${offset}` : API_ROOT;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function patchRecords(updates) {
  // Airtable allows a max of 10 records per PATCH request
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    const res = await fetch(API_ROOT, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      throw new Error(`Airtable patch failed: ${res.status} ${await res.text()}`);
    }
    console.log(`  updated ${chunk.length} record(s)`);
  }
}

function printBanner(regenerateAll) {
  console.log("============================================================");
  console.log(" Partners Mailto Link Generator");
  console.log(" Fills in \"Mailto Link\" for any Partners row that already");
  console.log(" has Name + Subject Line + Intro Paragraph written.");
  console.log(" ");
  console.log(regenerateAll
    ? " Mode: --all (regenerating EVERY row, including ones that"
    : " Mode: default (only filling in BLANK Mailto Link rows —"
  );
  console.log(regenerateAll
    ? "        already have a Mailto Link)"
    : "        run with --all to force-regenerate every row instead,"
  );
  if (!regenerateAll) console.log("        e.g. after editing the email template below)");
  console.log("============================================================\n");
}

async function main() {
  const regenerateAll = process.argv.includes("--all");
  printBanner(regenerateAll);

  console.log("Fetching records from Airtable...");
  const records = await fetchAllRecords();
  console.log(`Found ${records.length} total record(s) in Partners.`);

  const updates = [];
  const skippedMissingCopy = [];

  for (const r of records) {
    const f = r.fields || {};
    const name = f["Name"];
    const intro = f["Intro Paragraph"];
    const subject = f["Subject Line"];
    const email = f["Email"] || "";
    const existingMailto = f["Mailto Link"];

    if (!name || !intro || !subject) {
      skippedMissingCopy.push(name || r.id);
      continue;
    }

    if (existingMailto && !regenerateAll) continue;

    const mailto = buildMailto(email, subject, name, intro);
    updates.push({ id: r.id, fields: { "Mailto Link": mailto } });
  }

  if (skippedMissingCopy.length) {
    console.log(
      `\nSkipped ${skippedMissingCopy.length} record(s) missing Name/Subject Line/Intro Paragraph (write that copy first):`
    );
    skippedMissingCopy.forEach((n) => console.log(`  - ${n}`));
  }

  if (!updates.length) {
    console.log("\nNothing to update.");
    return;
  }

  console.log(`\nUpdating ${updates.length} record(s)...`);
  await patchRecords(updates);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
