#!/usr/bin/env node
/**
 * generate-gmail-drafts.js
 *
 * Creates a real Gmail DRAFT for each partner in the Airtable Partners table.
 * You then open Gmail, review each one, and hit Send yourself.
 *
 * WHY THIS REPLACES THE MAILTO APPROACH
 * --------------------------------------
 * mailto: links carry the email body inside a URL. Somewhere between Airtable
 * and the mail client, an extra decode pass was corrupting them: "%2B" became
 * a literal "+" (rendered as a space), and "%26" became a literal "&", which
 * TERMINATED the body parameter — that's why every draft cut off mid-sentence
 * at "specializing in queer" (the next chars being " & allied travel").
 *
 * This script sends the body as base64-encoded MIME instead of a URL, so &, +,
 * em-dashes, apostrophes, and line breaks are simply not special characters.
 * The whole class of bug disappears.
 *
 * NOTE: This creates DRAFTS ONLY. It never sends anything. Nothing touches
 * Gmail's sending limits or your domain's sender reputation until you
 * personally click Send on each one.
 *
 * USAGE
 * -----
 *   node scripts/generate-gmail-drafts.js              # dry run — prints what it WOULD create
 *   node scripts/generate-gmail-drafts.js --create     # actually create the drafts
 *   node scripts/generate-gmail-drafts.js --create --limit 3   # create just the first 3 (TEST THIS FIRST)
 *   node scripts/generate-gmail-drafts.js --create --force     # re-draft partners who already have one
 *
 * TRACKING — two different states, deliberately kept separate
 * -----------------------------------------------------------
 * "Draft Created" (date field, written by THIS script)
 *     = a Gmail draft exists for this partner. Rows with a date here are
 *       skipped on future runs, so re-running is safe and won't duplicate.
 *       Use --force to re-draft anyway (e.g. after editing someone's intro).
 *
 * "Status" (single-select, written by YOU, by hand)
 *     = the real relationship state. Flip it to "Contacted" once you actually
 *       hit Send in Gmail. The script never touches this field, because it
 *       genuinely cannot know whether you sent the draft or deleted it.
 *
 * ONE-TIME SETUP
 * --------------
 * 1. npm install googleapis @google-cloud/local-auth
 *
 * 2. Create a Google Cloud project + enable the Gmail API:
 *      https://console.cloud.google.com/apis/enableflow?apiid=gmail.googleapis.com
 *
 * 3. Configure the OAuth consent screen (Google Auth platform > Branding):
 *      - App name: anything ("Partner Outreach")
 *      - Audience: Internal  (you're on a Workspace domain, so this is available
 *        and means no Google verification review is needed)
 *
 * 4. Create credentials (Google Auth platform > Clients > Create Client):
 *      - Application type: Desktop app
 *      - Download the JSON, save it in the REPO ROOT as: credentials.json
 *
 * 5. Add BOTH of these to .gitignore (they are secrets — never commit them):
 *      credentials.json
 *      token.json
 *
 * 6. First run will pop open a browser asking you to authorize. After that it
 *    saves token.json and won't ask again.
 *
 * WHAT GETS SKIPPED (and why)
 * ----------------------------
 * - Rows with no Email address (contact-form-only businesses) — nothing to draft to.
 * - Rows with Status = "Closed" — Coping Cookies, Santé Bar, Crush Bar, etc.
 * - Rows missing Name / Subject Line / Intro Paragraph — copy isn't written yet.
 * All skips are listed at the end so you know exactly who needs manual handling.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");

// ---- .env loader (plain `node` doesn't read .env on its own) ----------------
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
if (!AIRTABLE_KEY) {
  console.error(
    "AIRTABLE_API_KEY is not set. Add it to your .env file in the repo root."
  );
  process.exit(1);
}

const BASE_ID = "appv81raB2A2g9x1Y";
const TABLE_ID = "tblUO05tbzi65COsl"; // Partners
const API_ROOT = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;

const REPO_ROOT = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(REPO_ROOT, "credentials.json");
const TOKEN_PATH = path.join(REPO_ROOT, "token.json");

// gmail.compose = create/read/modify drafts. Deliberately NOT gmail.send —
// this script has no ability to actually send mail, by design.
const SCOPES = ["https://www.googleapis.com/auth/gmail.compose"];

// =============================================================================
// EMAIL TEMPLATE — edit this block when reusing for a new event (e.g. Virgin
// Voyages). `name` and `intro` are the only variables available.
// =============================================================================
function buildBody(name, intro) {
  return [
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
  ].join("\r\n\r\n");
}
// =============================================================================

/**
 * Build an RFC 2822 MIME message, base64url-encoded for the Gmail API.
 * UTF-8 + base64 transfer encoding so em-dashes and accented characters
 * (Santé Bar, Taqueria Los Puñales) survive intact.
 */
function buildRawMessage(to, subject, bodyText) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const bodyBase64 = Buffer.from(bodyText, "utf8").toString("base64");

  const mime = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyBase64,
  ].join("\r\n");

  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function authorize() {
  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    return google.auth.fromJSON(saved);
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(
      `credentials.json not found at ${CREDENTIALS_PATH}\n` +
        "See the ONE-TIME SETUP section at the top of this file."
    );
    process.exit(1);
  }

  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials) {
    const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const key = keys.installed || keys.web;
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify({
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      })
    );
    console.log("Authorized. Saved token.json (don't commit it).\n");
  }
  return client;
}

async function fetchAllRecords() {
  const records = [];
  let offset;
  do {
    const url = offset ? `${API_ROOT}?offset=${offset}` : API_ROOT;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function main() {
  const args = process.argv.slice(2);
  const doCreate = args.includes("--create");
  const force = args.includes("--force");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log("============================================================");
  console.log(" Gmail Draft Generator — Partner Outreach");
  console.log(" Creates reviewable DRAFTS in Gmail. Never sends anything.");
  console.log("");
  console.log(
    doCreate
      ? " Mode: --create (drafts WILL be created in your Gmail)"
      : " Mode: DRY RUN (nothing will be created)"
  );
  if (!doCreate) {
    console.log("        Add --create to actually create them.");
    console.log("        Tip: start with --create --limit 3 to test.");
  }
  if (force) {
    console.log(" --force: re-drafting partners who ALREADY have a draft");
    console.log("          (you'll get duplicates unless you delete the old ones)");
  }
  if (limit) console.log(` Limit: first ${limit} eligible partner(s) only`);
  console.log("");
  console.log(" NOTE: 'Draft Created' in Airtable = this script made a draft.");
  console.log("       It does NOT mean the email was sent. Flip Status to");
  console.log("       'Contacted' yourself once you actually hit Send.");
  console.log("============================================================\n");

  console.log("Fetching partners from Airtable...");
  const records = await fetchAllRecords();
  console.log(`Found ${records.length} record(s).\n`);

  const eligible = [];
  const skippedNoEmail = [];
  const skippedClosed = [];
  const skippedNoCopy = [];
  const skippedAlreadyDrafted = [];

  for (const r of records) {
    const f = r.fields || {};
    const name = f["Name"];
    const intro = f["Intro Paragraph"];
    const subject = f["Subject Line"];
    const email = f["Email"];
    const status = f["Status"];
    const draftCreated = f["Draft Created"];

    if (status === "Closed") {
      skippedClosed.push(name || r.id);
      continue;
    }
    if (!name || !intro || !subject) {
      skippedNoCopy.push(name || r.id);
      continue;
    }
    if (!email) {
      skippedNoEmail.push(name);
      continue;
    }
    if (draftCreated && !force) {
      skippedAlreadyDrafted.push(`${name} (${draftCreated})`);
      continue;
    }
    eligible.push({ id: r.id, name, email, subject, intro });
  }

  const toProcess = limit ? eligible.slice(0, limit) : eligible;

  console.log(`Eligible for drafting: ${eligible.length}`);
  if (limit) console.log(`Processing this run:   ${toProcess.length}`);
  console.log("");

  if (skippedClosed.length) {
    console.log(`Skipped — marked Closed (${skippedClosed.length}):`);
    skippedClosed.forEach((n) => console.log(`  - ${n}`));
    console.log("");
  }
  if (skippedNoEmail.length) {
    console.log(
      `Skipped — no email on file (${skippedNoEmail.length}) — reach these via phone/Instagram/contact form:`
    );
    skippedNoEmail.forEach((n) => console.log(`  - ${n}`));
    console.log("");
  }
  if (skippedNoCopy.length) {
    console.log(`Skipped — missing Subject Line / Intro Paragraph (${skippedNoCopy.length}):`);
    skippedNoCopy.forEach((n) => console.log(`  - ${n}`));
    console.log("");
  }
  if (skippedAlreadyDrafted.length) {
    console.log(
      `Skipped — draft already created (${skippedAlreadyDrafted.length}) — use --force to re-draft:`
    );
    skippedAlreadyDrafted.forEach((n) => console.log(`  - ${n}`));
    console.log("");
  }

  if (!doCreate) {
    console.log("--- DRY RUN: would create drafts for ---");
    toProcess.forEach((p) => console.log(`  ${p.email.padEnd(38)} ${p.subject}`));
    console.log("\nRe-run with --create to actually create these drafts.");
    return;
  }

  if (!toProcess.length) {
    console.log("Nothing to create.");
    return;
  }

  const auth = await authorize();
  const gmail = google.gmail({ version: "v1", auth });

  console.log(`Creating ${toProcess.length} draft(s)...\n`);
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const succeeded = [];

  for (const p of toProcess) {
    const raw = buildRawMessage(p.email, p.subject, buildBody(p.name, p.intro));
    try {
      await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      succeeded.push(p);
      console.log(`  ✓ ${p.name}`);
    } catch (err) {
      console.error(`  ✗ ${p.name} — ${err.message}`);
    }
  }

  // Stamp "Draft Created" in Airtable, but ONLY for drafts that actually
  // succeeded — a failed draft must stay un-stamped so the next run retries it.
  if (succeeded.length) {
    console.log(`\nStamping "Draft Created" in Airtable...`);
    const updates = succeeded.map((p) => ({
      id: p.id,
      fields: { "Draft Created": today },
    }));
    for (let i = 0; i < updates.length; i += 10) {
      const chunk = updates.slice(i, i + 10);
      const res = await fetch(API_ROOT, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${AIRTABLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: chunk }),
      });
      if (!res.ok) {
        console.error(`  Airtable update failed: ${res.status} ${await res.text()}`);
      } else {
        console.log(`  stamped ${chunk.length} record(s)`);
      }
    }
  }

  console.log(`\nDone. Created ${succeeded.length} draft(s).`);
  console.log("Open Gmail → Drafts to review and send each one.");
  console.log(
    'Remember: flip Status to "Contacted" in Airtable once you actually hit Send.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
