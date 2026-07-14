#!/usr/bin/env node
/**
 * generate-gmail-drafts.js
 *
 * Creates a real Gmail DRAFT for each partner in one event cycle. You then
 * open Gmail, review each one, and hit Send yourself. This script never sends.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION — READ THIS
 * ---------------------------------------------------
 * The old version read TABLE_ID "tblUO05tbzi65COsl", commented as "Partners".
 * That is "Partners (legacy)" — the ARCHIVE table. It drafted from the old
 * 92-row roster (including businesses since cut as closed, non-existent, or
 * failing the affluence/density thesis) and stamped "Draft Created" onto
 * archive rows. That was a live footgun and it is now gone.
 *
 * This version reads the current schema:
 *
 *   Outreach (one row per Partner x Event)   tblstWlG7RC3R4fRA
 *     -> Partner   (stable facts)            tblFlH8ssP07XdrhZ
 *     -> Event     (per-cycle facts)         tbl8I56RgDqgXFpQ5
 *     + Templates  (copy lives in Airtable)  tblwww889pqm5NAGE
 *
 * All table references are by IMMUTABLE TABLE ID, never by name. Names are
 * mutable, and there is an archive table one rename away from being the thing
 * this script writes to. That is exactly the mistake being fixed here.
 *
 * The email body no longer lives in this file. The old buildBody() hardcoded
 * "Tuesday, September 22nd with Celebrity Cruises", which meant every new
 * cycle required editing JavaScript — and the same template had already been
 * copy-pasted into generate-mailto-links.js and drifted. Copy now lives in the
 * Templates table so it can be edited without touching code.
 *
 * USAGE
 * -----
 *   node scripts/generate-gmail-drafts.js --event=celebrity-alaska
 *       Dry run. Prints every rendered email in full. Creates nothing.
 *       Requires no Gmail credentials at all. ALWAYS RUN THIS FIRST.
 *
 *   node scripts/generate-gmail-drafts.js --event=celebrity-alaska --create --limit 3
 *       Create the first 3 drafts. Do this before a full run.
 *
 *   node scripts/generate-gmail-drafts.js --event=celebrity-alaska --create
 *       Create all eligible drafts.
 *
 *   node scripts/generate-gmail-drafts.js --event=celebrity-alaska --touch=2 --create
 *       Touch 2 (day 8). Touch 3 is day 18. Then stop — a fourth email to a
 *       neighborhood business costs the relationship.
 *
 *   --force   Re-draft partners who already have a Draft Subject/Draft Body.
 *             You will get duplicate Gmail drafts unless you delete the old ones.
 *
 * TRACKING — three states, deliberately kept separate
 * ----------------------------------------------------
 * Outreach."Draft Subject" / "Draft Body"  (written by THIS script)
 *     = a Gmail draft exists. Rows with these populated are skipped on reruns,
 *       so re-running is safe. --force overrides.
 *
 * Outreach."Touch 1/2/3 Sent"  (written by YOU, by hand)
 *     = you actually clicked Send. The script cannot know whether you sent the
 *       draft or deleted it, so it will not guess.
 *
 * Partners."Status"  (written by YOU; ALSO READ BY generate-qr-codes.js)
 *     = the relationship state. 'Confirmed' -> 'QR Generated' drives the QR
 *       script. DO NOT REPURPOSE THIS FIELD.
 *
 * THE TWO GATES
 * -------------
 * 1. Empty "Specific Detail" -> SKIP. That blank means nobody has found one
 *    true, sourced sentence about this business. The row is skipped rather than
 *    padded with a generic line. The blank is a feature. Do not "fix" it by
 *    defaulting to filler.
 *
 * 2. "Contact Method" != Email -> SKIP. Roughly 20 of the 52 partners are
 *    DM / phone / in-person only. Route those to the Phone and Instagram DM
 *    scripts in the Templates table.
 *
 * Plus a hard assert: if any {Token} survives rendering, the row is skipped
 * loudly. A body reading "Hi there, ... {Event Hook} ..." landing in a
 * partner's inbox costs the relationship, not just the send.
 *
 * ONE-TIME SETUP (unchanged — your existing credentials.json/token.json work)
 * ---------------------------------------------------------------------------
 * 1. npm install googleapis @google-cloud/local-auth
 * 2. Enable the Gmail API:
 *      https://console.cloud.google.com/apis/enableflow?apiid=gmail.googleapis.com
 * 3. OAuth consent screen: App name anything, Audience = Internal.
 * 4. Credentials > Create Client > Desktop app. Save JSON to repo root as
 *    credentials.json
 * 5. .gitignore BOTH credentials.json and token.json. They are secrets.
 * 6. First run opens a browser to authorize, then saves token.json.
 *
 * Also required, in .env at the repo root:
 *      AIRTABLE_API_KEY=pat_...
 *      REGISTRATION_URL=https://...      <- the {Registration URL} token
 *
 * REGISTRATION_URL is an env var because the Events table has no field for it
 * (the RSVP URL currently lives only in Vercel Edge Config as
 * CURRENT_EVENT_RSVP_URL). The better fix is a "Registration URL" field on the
 * Events table so it is per-cycle rather than per-run. Until then, this.
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

// Immutable table IDs. Never substitute names.
// tblUO05tbzi65COsl is "Partners (legacy)" — the archive. Deliberately absent.
const TABLES = {
  events: "tbl8I56RgDqgXFpQ5",
  partners: "tblFlH8ssP07XdrhZ",
  outreach: "tblstWlG7RC3R4fRA",
  templates: "tblwww889pqm5NAGE",
};

const apiRoot = (tableId) => `https://api.airtable.com/v0/${BASE_ID}/${tableId}`;

const REPO_ROOT = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(REPO_ROOT, "credentials.json");
const TOKEN_PATH = path.join(REPO_ROOT, "token.json");

// gmail.compose = create/read/modify drafts. Deliberately NOT gmail.send —
// this script has no ability to actually send mail, by design.
const SCOPES = ["https://www.googleapis.com/auth/gmail.compose"];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const getEq = (name) => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`));
    return flag ? flag.split("=").slice(1).join("=") : undefined;
  };

  const eventSlug = getEq("event");
  if (!eventSlug) {
    console.error(
      "Missing required flag: --event=<slug>\n" +
        "  e.g. --event=celebrity-alaska\n" +
        "  Known slugs: celebrity-alaska, virgin-voyages, crystal-amawaterways, rocky-mountaineer"
    );
    process.exit(1);
  }

  const limitIdx = argv.indexOf("--limit");
  const limit =
    limitIdx !== -1 ? parseInt(argv[limitIdx + 1], 10) : Number(getEq("limit")) || null;

  return {
    eventSlug,
    touch: Number(getEq("touch") || 1),
    create: argv.includes("--create"),
    force: argv.includes("--force"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}

// ---------------------------------------------------------------------------
// airtable
// ---------------------------------------------------------------------------

async function fetchAll(tableId, fields) {
  const records = [];
  let offset;
  do {
    const url = new URL(apiRoot(tableId));
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    });
    if (!res.ok) {
      throw new Error(
        `Airtable fetch failed for ${tableId}: ${res.status} ${await res.text()}`
      );
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function patchRecords(tableId, updates) {
  // Airtable allows a max of 10 records per PATCH request.
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    const res = await fetch(apiRoot(tableId), {
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

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render(template, tokens) {
  return String(template || "").replace(/\{([^}]+)\}/g, (match, key) => {
    const value = tokens[key.trim()];
    return value === undefined || value === null || value === "" ? match : value;
  });
}

function findUnresolvedTokens(...rendered) {
  const found = new Set();
  for (const text of rendered) {
    for (const m of text.matchAll(/\{[^}]+\}/g)) found.add(m[0]);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// gmail
// ---------------------------------------------------------------------------

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

/**
 * RFC 2822 MIME, base64url-encoded for the Gmail API. UTF-8 + base64 transfer
 * encoding so em-dashes, curly apostrophes and accented characters (Taqueria
 * Los Puñales) survive intact. This is also why the mailto approach was
 * abandoned: a body inside a URL gets an extra decode pass somewhere in the
 * chain, "%26" becomes a literal "&", and the body parameter terminates
 * mid-sentence. Base64 MIME has no special characters, so the whole class of
 * bug disappears.
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const registrationUrl = process.env.REGISTRATION_URL;
  if (!registrationUrl) {
    console.error(
      "REGISTRATION_URL is not set. Add it to .env — it is the {Registration URL} token."
    );
    process.exit(1);
  }

  console.log("============================================================");
  console.log(" Gmail Draft Generator — Partner Outreach");
  console.log(" Creates reviewable DRAFTS in Gmail. Never sends anything.");
  console.log("");
  console.log(` Event: ${args.eventSlug}`);
  console.log(` Touch: ${args.touch}`);
  console.log(
    args.create
      ? " Mode:  --create (drafts WILL be created in your Gmail)"
      : " Mode:  DRY RUN (nothing will be created)"
  );
  if (!args.create) {
    console.log("        Add --create to actually create them.");
    console.log("        Tip: start with --create --limit 3 to test.");
  }
  if (args.force) {
    console.log(" --force: re-drafting partners who ALREADY have a draft");
    console.log("          (you'll get duplicates unless you delete the old ones)");
  }
  if (args.limit) console.log(` Limit: first ${args.limit} eligible partner(s) only`);
  console.log("");
  console.log(' NOTE: Draft Subject/Body in Airtable = a draft was made.');
  console.log("       It does NOT mean the email was sent. Stamp Touch N Sent");
  console.log("       yourself once you actually hit Send.");
  console.log("============================================================\n");

  console.log("Fetching from Airtable...");
  const [events, partners, templates, outreach] = await Promise.all([
    fetchAll(TABLES.events, [
      "Event Name",
      "Slug",
      "Portfolio Partner",
      "Event Hook",
      "Event Date (Display)",
    ]),
    fetchAll(TABLES.partners, [
      "Name",
      "Email",
      "Contact Method",
      "Greeting Name",
      "Specific Detail",
    ]),
    fetchAll(TABLES.templates, [
      "Template Name",
      "Touch Number",
      "Channel",
      "Subject Template",
      "Body Template",
      "Active",
    ]),
    fetchAll(TABLES.outreach, [
      "Outreach",
      "Partner",
      "Event",
      "Draft Subject",
      "Draft Body",
    ]),
  ]);

  // --- resolve the event -----------------------------------------------------

  const event = events.find((e) => e.fields.Slug === args.eventSlug);
  if (!event) {
    console.error(
      `No Event row with Slug "${args.eventSlug}".\n` +
        `Known slugs: ${events.map((e) => e.fields.Slug).filter(Boolean).join(", ")}`
    );
    process.exit(1);
  }

  const missingEventFields = [
    "Portfolio Partner",
    "Event Hook",
    "Event Date (Display)",
  ].filter((f) => !event.fields[f]);

  if (missingEventFields.length) {
    console.error(
      `Event "${args.eventSlug}" is missing: ${missingEventFields.join(", ")}.\n` +
        "Fill these in on the Events table before rendering."
    );
    process.exit(1);
  }

  // --- resolve the template --------------------------------------------------
  //
  // Matching on Channel AND Touch Number AND Active is deliberate. Without the
  // Channel filter, a naive lookup by touch number will non-deterministically
  // grab the Phone or Instagram DM script, which are also Touch 1.

  const template = templates.find(
    (t) =>
      t.fields.Channel === "Email" &&
      Number(t.fields["Touch Number"]) === args.touch &&
      t.fields.Active === true
  );

  if (!template) {
    console.error(
      `No ACTIVE Email template with Touch Number ${args.touch} in the Templates table.`
    );
    process.exit(1);
  }
  console.log(`Template: ${template.fields["Template Name"]}\n`);

  const partnersById = new Map(partners.map((p) => [p.id, p]));
  const rows = outreach.filter((o) => (o.fields.Event || []).includes(event.id));
  console.log(`Outreach rows for this event: ${rows.length}\n`);

  // --- render + gate ---------------------------------------------------------

  const eligible = [];
  const skippedNoPartner = [];
  const skippedNoDetail = [];
  const skippedNotEmail = [];
  const skippedNoAddress = [];
  const skippedAlreadyDrafted = [];
  const skippedBadTokens = [];

  for (const row of rows) {
    const partnerId = (row.fields.Partner || [])[0];
    const partner = partnerId ? partnersById.get(partnerId) : undefined;

    if (!partner) {
      skippedNoPartner.push(row.fields.Outreach || row.id);
      continue;
    }

    const p = partner.fields;
    const name = p.Name || partner.id;

    // GATE 1 — the quality gate.
    if (!p["Specific Detail"]) {
      skippedNoDetail.push(name);
      continue;
    }

    // GATE 2 — channel.
    if (p["Contact Method"] !== "Email") {
      skippedNotEmail.push(`${name} (${p["Contact Method"] || "no method set"})`);
      continue;
    }

    if (!p.Email) {
      skippedNoAddress.push(name);
      continue;
    }

    if (!args.force && (row.fields["Draft Subject"] || row.fields["Draft Body"])) {
      skippedAlreadyDrafted.push(name);
      continue;
    }

    const tokens = {
      "Greeting Name": p["Greeting Name"] || "there",
      "Partner Name": p.Name,
      "Specific Detail": p["Specific Detail"],
      "Event Date": event.fields["Event Date (Display)"],
      "Event Portfolio": event.fields["Portfolio Partner"],
      "Event Hook": event.fields["Event Hook"],
      "Registration URL": registrationUrl,
    };

    const subject = render(template.fields["Subject Template"], tokens);
    const body = render(template.fields["Body Template"], tokens);

    const unresolved = findUnresolvedTokens(subject, body);
    if (unresolved.length) {
      skippedBadTokens.push(`${name} — ${unresolved.join(", ")}`);
      continue;
    }

    eligible.push({
      outreachId: row.id,
      name: p.Name,
      email: p.Email,
      subject,
      body,
    });
  }

  const toProcess = args.limit ? eligible.slice(0, args.limit) : eligible;

  // --- report skips ----------------------------------------------------------

  const reportSkips = (label, list, note) => {
    if (!list.length) return;
    console.log(`Skipped — ${label} (${list.length})${note ? ` — ${note}` : ""}:`);
    list.forEach((n) => console.log(`  - ${n}`));
    console.log("");
  };

  reportSkips(
    "no Specific Detail",
    skippedNoDetail,
    "the quality gate, working as designed. Write one sourced sentence or leave them out"
  );
  reportSkips(
    "not an Email channel",
    skippedNotEmail,
    "route these to the Phone / Instagram DM scripts in Templates"
  );
  reportSkips(
    "Email channel but no address",
    skippedNoAddress,
    "data error — fix in Airtable"
  );
  reportSkips("draft already exists", skippedAlreadyDrafted, "use --force to re-draft");
  reportSkips("no linked Partner", skippedNoPartner, "broken Outreach row");
  reportSkips("UNRESOLVED TOKENS", skippedBadTokens, "template or Event data is incomplete");

  console.log(`Eligible for drafting: ${eligible.length}`);
  if (args.limit) console.log(`Processing this run:   ${toProcess.length}`);
  console.log("");

  // --- dry run ---------------------------------------------------------------

  if (!args.create) {
    for (const d of toProcess) {
      console.log("─".repeat(72));
      console.log(`TO:      ${d.name} <${d.email}>`);
      console.log(`SUBJECT: ${d.subject}`);
      console.log("");
      console.log(d.body);
      console.log("");
    }
    console.log("─".repeat(72));
    console.log("\nDRY RUN — no Gmail drafts created, no Airtable fields written.");
    console.log("Re-run with --create to actually create these drafts.");
    return;
  }

  if (!toProcess.length) {
    console.log("Nothing to create.");
    return;
  }

  // --- create ----------------------------------------------------------------

  const auth = await authorize();
  const gmail = google.gmail({ version: "v1", auth });

  console.log(`Creating ${toProcess.length} draft(s)...\n`);
  const succeeded = [];

  for (const d of toProcess) {
    const raw = buildRawMessage(d.email, d.subject, d.body);
    try {
      await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      succeeded.push(d);
      console.log(`  ✓ ${d.name}`);
    } catch (err) {
      console.error(`  ✗ ${d.name} — ${err.message}`);
    }
  }

  // Write Draft Subject/Body back to Airtable, but ONLY for drafts that
  // actually succeeded — a failed draft must stay un-stamped so the next run
  // retries it rather than silently skipping it forever.
  if (succeeded.length) {
    console.log(`\nWriting Draft Subject / Draft Body to Outreach...`);
    await patchRecords(
      TABLES.outreach,
      succeeded.map((d) => ({
        id: d.outreachId,
        fields: { "Draft Subject": d.subject, "Draft Body": d.body },
      }))
    );
  }

  console.log(`\nDone. Created ${succeeded.length} draft(s).`);
  console.log("Open Gmail → Drafts to review and send each one.");
  console.log(
    `Remember: stamp "Touch ${args.touch} Sent" on the Outreach row once you actually hit Send.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
