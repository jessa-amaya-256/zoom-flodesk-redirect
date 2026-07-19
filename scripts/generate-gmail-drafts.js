#!/usr/bin/env node
/**
 * generate-gmail-drafts.js  —  one reviewable Gmail DRAFT per partner, per cycle.
 * You open Gmail and hit Send yourself. This script NEVER sends.
 *
 * DATA MODEL (all refs are IMMUTABLE table IDs — names are mutable, and the
 * archive "Partners (legacy)" tblUO05tbzi65COsl is one rename from being the
 * thing this writes to, so it is deliberately absent):
 *   Outreach  tblstWlG7RC3R4fRA   one row per Partner x Event (touches live here)
 *     -> Partner   tblFlH8ssP07XdrhZ   stable business facts
 *     -> Event     tbl8I56RgDqgXFpQ5   per-cycle facts
 *   Templates tblwww889pqm5NAGE   copy lives in Airtable, not in this file, so a
 *                                 new cycle never means editing JavaScript.
 *   Opener & Identity Lines  tblW1KErf9l3Ku9MX   the entity/ownership-aware opener clause,
 *                                 keyed by Ownership, holding a nested {City}. Also
 *                                 holds the warm Identity Line, keyed the same way.
 *   Ask Snippets tblhCsZ7X9SDdUWcq  the full warm ask sentence, keyed by Best
 *                                 Ask. The "Assembled Example" IS the sentence.
 *
 * COLD vs WARM. Touch 1 comes in two registers, chosen PER PARTNER by the Lead
 * Type of the template the partner is linked to (Partners."Target Template" ->
 * Templates."Lead Type"). A partner with no link, or a link to a Cold template,
 * takes the COLD path. A link to a Warm template takes the WARM path. Everything
 * on Touch 2 / Touch 3 is a single ask-agnostic follow-up and always cold-shaped.
 *
 * TOKENS — COLD (the "you kept coming up" cold open):
 *   {Greeting Name} {Partner Name} {Specific Detail}
 *   {Event Date} {Event Portfolio} {Event Hook} {Registration URL}
 *   {City}          <- Partners.City, else DEFAULT_CITY_PHRASE. Not a gate.
 *   {Opener Clause} <- Opener & Identity Lines, keyed by Partners.Ownership, fallback to the
 *                      "Unverified" row. The clause TEXT lives in Airtable now, not
 *                      in this file, and it CONTAINS a nested {City}, so the body is
 *                      rendered until no {tokens} remain (see renderDeep). "Queer-
 *                      owned (verified)" earns the pointed "queer-owned"; everyone
 *                      else gets the inclusive "queer-owned and queer-friendly".
 *                      NEVER claim ownership we cannot verify (Metier / Browsers).
 *                      ALSO entity-aware, via Partners.Entity Type: a Business (the
 *                      blank default) gets "researching the ... businesses around
 *                      {City}", an Organization gets "getting to know the ...
 *                      corners of {City}" (the "Opener Clause (Org)" column), so a
 *                      nonprofit is never called a business (the 9.9 error).
 *   {Secondary Ask Line} <- Partners.Secondary Ask, via SECONDARY_ASK_LINES.
 *                      Blank-safe: spliced in BEFORE render() so an empty one
 *                      vanishes instead of tripping the unresolved-token gate.
 *   {Cold Ask Block} <- Ask Snippets."Cold Ask Block", keyed by Best Ask.
 *                      The WHOLE ask paragraph. This is what lets one "favor"
 *                      template serve Card / Newsletter / Social Post / Co-hosted
 *                      Event instead of four near-identical templates. Referral
 *                      Deal and Introducer keep their own full templates (their
 *                      letter is structurally different) and do not use this.
 *                      Unknown or blank ask falls back to the Card block.
 *   {Cold Ask Closer} <- Ask Snippets."Cold Ask Closer", keyed by Best Ask.
 *                      An optional trailing line after the close. Only the Card
 *                      ask sets one ("Coffee on me either way."). Blank-safe
 *                      (spliced), so it vanishes for every other ask.
 *
 * TOKENS — WARM (the "really glad we got to talk" note to someone already met):
 *   {Greeting Name} <- Partners.Greeting Name.
 *   {Meeting Context} <- Partners.Meeting Context. The author bakes in the
 *                      preposition ("in your chair", "at the July SNW meeting").
 *   {Callback}      <- Partners.Callback. Optional, blank-safe (spliced).
 *   {Memory Jog}    <- COMPUTED from Partners."Last Interaction", falling back to
 *                      Partners.Met Date when that is blank. Empty if the most
 *                      recent contact was today or yesterday, else "Just to jog
 *                      your memory, " (the trailing comma+space is intentional).
 *                      Met Date is the FIRST meeting; Last Interaction is the most
 *                      recent one, and recency is what decides whether a reminder
 *                      is needed. Blank-safe (spliced).
 *   {Identity Line} <- Opener & Identity Lines.Identity Line, keyed by Partners.Ownership,
 *                      fallback "Unverified". The word "too" claims shared queer
 *                      identity, so it rides ONLY on the verified row.
 *   {Ask Sentence}  <- Ask Snippets."Assembled Example", keyed by Partners.
 *                      Best Ask. No match = the partner is skipped LOUDLY rather
 *                      than mailed a half-rendered body.
 *
 * TEMPLATE SELECTION: Touch 1 COLD is chosen PER PARTNER by Partners.Best Ask
 *   matched to Templates.Ask (Card / Referral Deal / Co-hosted Event / Newsletter /
 *   Social Post / Introducer). A template with no Ask = Card, so it stays
 *   backward-compatible. Touch 1 WARM is the single Lead Type = Warm template.
 *   Touch 2 and Touch 3 are ask-agnostic (one of each serves everyone). The
 *   Channel filter is deliberate: without it a touch lookup could grab the Phone
 *   or Instagram DM script, which are also Touch 1.
 *
 * CYCLE: --event is optional. Omitted, the active cycle is the earliest event
 *   whose "Event Start (UTC)" is still in the future (rolls over at showtime).
 *   The banner always states which cycle was chosen. Pass --event=<slug> to
 *   override, which is what you want when cleaning up a cycle already begun.
 *
 * USAGE:
 *   node scripts/generate-gmail-drafts.js                     dry run, prints every email
 *   node scripts/generate-gmail-drafts.js --create --limit 3  create the first 3
 *   node scripts/generate-gmail-drafts.js --create            create all eligible
 *   node scripts/generate-gmail-drafts.js --touch=2 --create  day-8 follow-up (touch 3 = day 18, then STOP)
 *   node scripts/generate-gmail-drafts.js --wave=1 --create   only Wave 1 partners
 *   --event=<slug>  override the auto-selected cycle
 *   --wave=<n|name> draft only partners in ONE wave (matches the Partners
 *                   "Wave" field). Accepts a number, --wave=1, or any part of
 *                   the name, --wave="Snohomish". Composes with every other flag.
 *                   Note: this only narrows WHICH rows are considered. The email
 *                   generator still drafts only Contact Method = Email partners,
 *                   so a wave with phone / DM / form partners yields fewer drafts.
 *   --force         re-draft a sent touch, or draft a follow-up early. Does NOT
 *                   override the Replied gate or the Cluster gate. Nothing does.
 *
 * A TOUCH IS DUE only if: they have not Replied; "Touch N Sent" is blank; "Touch
 *   N-1 Sent" is filled; and enough days have passed since it was SENT. The wait
 *   comes from Templates."Send Offset (Days)" (0 / 8 / 18). Zero-eligible on a
 *   follow-up run is the normal, healthy state. You stamp "Touch N Sent" and
 *   "Replied" BY HAND — the script cannot know whether you sent a draft or deleted
 *   it. Draft Subject / Draft Body are output, not a gate (treating them as one is
 *   what once made touch 2 skip everybody).
 *
 * GATES (skip loudly): handwrite (bespoke letter, auto-draft disabled); cluster
 *   member who is not the Lead (one human, one letter; the Lead's copy names both
 *   rooms); Replied; touch already sent / not yet due; blank Specific Detail (the
 *   quality gate — COLD ONLY, a warm note does not use it); Contact Method != Email
 *   (route to the Phone / Instagram DM copy); missing address; a warm partner with
 *   no matching Ask Snippet. Plus a HARD ASSERT: if any {Token} survives
 *   rendering, the row is skipped rather than mailed broken.
 *
 * DEPLOY ORDER, whenever you add a token or template: ship the CODE first, then
 *   put the token in a Template. The unresolved-token assert skips any row whose
 *   template holds a token the code does not yet supply — safe, but it stalls a
 *   cycle until the code catches up.
 *
 * SETUP (one time): npm install googleapis @google-cloud/local-auth; enable the
 *   Gmail API; OAuth desktop client saved as credentials.json (gitignored); first
 *   run authorizes and writes token.json (gitignored). Scope is gmail.compose, NOT
 *   gmail.send — this script cannot send mail, by design. .env needs exactly
 *   AIRTABLE_API_KEY. The RSVP link is per-cycle on the Events table, not an env
 *   var, so an unpopulated cycle refuses to draft rather than render the wrong link.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");
const { resolveCurrentEvent } = require("./current-event");

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

// Fallback for the {City} token when a Partner row has no City set.
//
// Deliberately NOT a hard gate, unlike "Specific Detail". A blank Specific
// Detail means nobody found one true thing to say about the business, and
// skipping that row is the entire point of the gate. A blank City is just a
// missing metadata field, and the sentence stays true without it:
// "researching queer-owned businesses around the Puget Sound area" is
// accurate for every partner in this base.
//
// So a missing City degrades gracefully rather than killing an otherwise good
// row. It reads correctly in the slot it lands in, which is:
//
//   "...researching queer-owned businesses around {City} while I was getting
//    my own travel practice ready to launch."
const DEFAULT_CITY_PHRASE = "the Puget Sound area";

// The {Secondary Ask Line} token. The PRIMARY ask lives in the ask-type
// template (chosen by Best Ask). The SECONDARY ask rides in here, as one
// blank-safe sentence keyed off Partners."Secondary Ask".
//
// A partner with no Secondary Ask maps to "" and the token vanishes, so a
// template carrying {Secondary Ask Line} still renders cleanly for everyone.
// Each value carries a LEADING SPACE so it appends after the primary ask
// without leaving a double space when it is absent. Place the token with no
// space in front of it, e.g.:
//   "...which I plan to do anyway.{Secondary Ask Line} No is a completely fine answer."
//
// House style: no em dashes, no semicolons, US spelling.
const SECONDARY_ASK_LINES = {
  "Social Post":
    " And if it ever felt right to share it with your followers, that would be a real bonus, though the card alone is more than enough.",
  "Co-hosted Event":
    " And if you ever wanted to host one of these in your own space, I would love that, with no expectation attached.",
  Newsletter:
    " Or a single line in your newsletter whenever one is already going out, if that is ever the easier thing.",
  "Referral Deal":
    " And if a client of yours is ever dreaming up a trip, I would be honored to be someone you point them to.",
};

// Immutable table IDs. Never substitute names.
// tblUO05tbzi65COsl is "Partners (legacy)" — the archive. Deliberately absent.
const TABLES = {
  events: "tbl8I56RgDqgXFpQ5",
  partners: "tblFlH8ssP07XdrhZ",
  outreach: "tblstWlG7RC3R4fRA",
  templates: "tblwww889pqm5NAGE",
  openerClauses: "tblW1KErf9l3Ku9MX",
  warmAskSnippets: "tblhCsZ7X9SDdUWcq",
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

  // --event is OPTIONAL. When omitted, the active cycle is derived from
  // Airtable: the earliest event whose "Event Start (UTC)" is still in the
  // future. Rollover happens at the instant the Zoom is scheduled to begin.
  // Pass --event explicitly to override — which is what you want when doing
  // cleanup on a cycle whose event has already started.
  const eventSlug = getEq("event");

  const limitIdx = argv.indexOf("--limit");
  const limit =
    limitIdx !== -1 ? parseInt(argv[limitIdx + 1], 10) : Number(getEq("limit")) || null;

  return {
    eventSlug,
    touch: Number(getEq("touch") || 1),
    create: argv.includes("--create"),
    force: argv.includes("--force"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    wave: getEq("wave") || null,
  };
}

// Does a partner's "Wave" value match the --wave query?
// Accepts a bare number (--wave=1 matches "Wave 1 — Snohomish") or any
// case-insensitive substring of the wave name (--wave="Snohomish"). A blank
// query matches everything, so --wave omitted leaves behavior unchanged.
function waveMatches(partnerWave, query) {
  if (!query) return true;
  const w = String(partnerWave || "").toLowerCase().trim();
  if (!w) return false;
  const q = String(query).toLowerCase().trim();
  if (/^\d+$/.test(q)) return new RegExp(`\\bwave\\s*${q}\\b`).test(w);
  return w.includes(q);
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

// render() only makes ONE pass, and String.replace does not re-scan the text it
// just substituted. That matters because {Opener Clause} resolves to a string
// that itself contains {City}. renderDeep runs render until the output stops
// changing (or a small cap is hit), so a token nested inside another token's
// value still gets resolved. A token whose value is missing stays literal and is
// left for the unresolved-token assert to catch, exactly as before.
function renderDeep(template, tokens) {
  let prev = String(template || "");
  for (let i = 0; i < 6; i++) {
    const next = render(prev, tokens);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function findUnresolvedTokens(...rendered) {
  const found = new Set();
  for (const text of rendered) {
    for (const m of text.matchAll(/\{[^}]+\}/g)) found.add(m[0]);
  }
  return [...found];
}

// The {Memory Jog} token for the WARM path. Recency of the MOST RECENT contact
// is what decides this, so the caller passes Last Interaction and falls back to
// Met Date. A contact from today or yesterday needs no reminder, so the jog is
// empty. Anything older opens with a gentle "Just to jog your memory, ". The
// trailing comma+space is intentional: the token sits directly in front of
// {Identity Line} with no separator of its own. A blank date is treated as "not
// recent" and gets the jog, because we cannot prove the contact was fresh.
function computeMemoryJog(lastContactRaw) {
  if (!lastContactRaw) return "Just to jog your memory, ";
  const two = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const when = String(lastContactRaw).slice(0, 10);
  if (when === ymd(today) || when === ymd(yesterday)) return "";
  return "Just to jog your memory, ";
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

  console.log("Fetching from Airtable...");
  const [events, partners, templates, outreach, openerClauses, warmAskSnippets] =
    await Promise.all([
      fetchAll(TABLES.events, [
        "Event Name",
        "Slug",
        "Event Start (UTC)", // drives auto-selection of the active cycle
        "Portfolio Partner",
        "Event Hook",
        "Event Date (Display)",
        "Registration URL",
      ]),
      fetchAll(TABLES.partners, [
        "Name",
        "Email",
        "Contact Method",
        "Greeting Name",
        "Specific Detail",
        "City", // feeds the {City} token. See DEFAULT_CITY_PHRASE.
        "Cluster", // one human, multiple rooms. See GATE 1.
        "Cluster Lead", // exactly one row per cluster gets the letter.
        "Best Ask", // selects the cold Touch 1 template AND the warm ask sentence.
        "Wave", // geographic send-sequence. Read only when --wave narrows the run.
        "Secondary Ask", // fills {Secondary Ask Line}. Blank -> token renders empty.
        "Ownership", // keys {Opener Clause} and warm {Identity Line}.
        "Entity Type", // Business (default) vs Organization -> picks the opener variant.
        "Target Template", // -> its Lead Type routes the partner cold vs warm.
        "Meeting Context", // warm {Meeting Context}. Preposition baked in.
        "Met Date", // FIRST meeting. Fallback source for {Memory Jog}.
        "Last Interaction", // most recent contact. Primary source for {Memory Jog}.
        "Callback", // warm {Callback}. Optional, blank-safe.
        "Handwrite", // GATE 0: checked = skip auto-drafting entirely; bespoke hand-written letter (see Notes).
      ]),
      fetchAll(TABLES.templates, [
        "Template Name",
        "Touch Number",
        "Channel",
        "Ask", // which ask this template voices. Matched against partner Best Ask.
        "Lead Type", // Cold / Warm. Routes each partner to a cold or warm render.
        "Subject Template",
        "Body Template",
        "Send Offset (Days)", // 0 / 8 / 18 — gates when a follow-up is due
        "Active",
      ]),
      fetchAll(TABLES.outreach, [
        "Outreach",
        "Partner",
        "Event",
        "Stage",
        "Touch 1 Sent",
        "Touch 2 Sent",
        "Touch 3 Sent",
        "Replied",
        "Draft Subject",
        "Draft Body",
      ]),
      fetchAll(TABLES.openerClauses, [
        "Ownership", // key
        "Opener Clause", // cold opener, BUSINESS variant, contains a nested {City}
        "Opener Clause (Org)", // cold opener, ORGANIZATION variant ("corners of", not "businesses")
        "Identity Line", // warm identity sentence
      ]),
      fetchAll(TABLES.warmAskSnippets, [
        "Best Ask", // key
        "Assembled Example", // the full warm ask sentence
        "Cold Ask Block", // the full cold ask paragraph, for the consolidated cold favor template
        "Cold Ask Closer", // optional trailing line after the cold close (only Card uses it)
      ]),
    ]);

  // --- fragment lookups ------------------------------------------------------
  //
  // The opener clause and the warm identity line are BOTH keyed by Ownership and
  // BOTH live on the Opener & Identity Lines table. The warm ask sentence is keyed by
  // Best Ask on the Ask Snippets table. Loading them into plain maps keeps
  // all outward-facing prose in Airtable — this file writes none of it.

  const openerClauseByOwnership = {}; // BUSINESS variant, keyed by Ownership
  const openerClauseOrgByOwnership = {}; // ORGANIZATION variant, keyed by Ownership
  const identityLineByOwnership = {};
  for (const r of openerClauses) {
    const key = String(r.fields["Ownership"] || "").trim();
    if (!key) continue;
    if (r.fields["Opener Clause"]) openerClauseByOwnership[key] = r.fields["Opener Clause"];
    if (r.fields["Opener Clause (Org)"]) openerClauseOrgByOwnership[key] = r.fields["Opener Clause (Org)"];
    if (r.fields["Identity Line"]) identityLineByOwnership[key] = r.fields["Identity Line"];
  }

  const askSentenceByAsk = {};
  const coldAskByAsk = {};
  for (const r of warmAskSnippets) {
    const key = String(r.fields["Best Ask"] || "").trim();
    if (!key) continue;
    if (r.fields["Assembled Example"]) {
      askSentenceByAsk[key] = r.fields["Assembled Example"];
    }
    // The consolidated cold favor template (Card / Newsletter / Social Post /
    // Co-hosted Event) pulls its whole ask paragraph from here, keyed by Best
    // Ask, plus an optional closing line. Referral Deal and Introducer keep
    // their own full templates and leave these blank.
    if (r.fields["Cold Ask Block"]) {
      coldAskByAsk[key] = {
        block: r.fields["Cold Ask Block"],
        closer: r.fields["Cold Ask Closer"] || "",
      };
    }
  }

  // Lead Type per template ID. A partner routes cold vs warm by the Lead Type of
  // the template it is linked to (Partners."Target Template").
  const leadTypeByTemplateId = new Map(
    templates.map((t) => [t.id, String(t.fields["Lead Type"] || "").trim()])
  );

  // --- resolve the event -----------------------------------------------------

  let event;
  let autoSelected = false;

  if (args.eventSlug) {
    event = events.find((e) => e.fields.Slug === args.eventSlug);
    if (!event) {
      console.error(
        `No Event row with Slug "${args.eventSlug}".\n` +
          `Known slugs: ${events.map((e) => e.fields.Slug).filter(Boolean).join(", ")}`
      );
      process.exit(1);
    }
  } else {
    try {
      event = resolveCurrentEvent(events);
      autoSelected = true;
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // Banner AFTER resolution, so the cycle it prints is the cycle it will
  // actually use. An auto-selected cycle says so, loudly — you should never
  // have to wonder which cycle a run of --create just drafted into.
  console.log("");
  console.log("============================================================");
  console.log(" Gmail Draft Generator — Partner Outreach");
  console.log(" Creates reviewable DRAFTS in Gmail. Never sends anything.");
  console.log("");
  console.log(` Cycle: ${event.fields["Event Name"]}  [${event.fields.Slug}]`);
  console.log(
    autoSelected
      ? "        ^ AUTO-SELECTED from Airtable (earliest event still in the future)."
      : "        ^ set explicitly via --event."
  );
  if (autoSelected) {
    console.log(`        Rolls over at ${event.fields["Event Start (UTC)"]}.`);
  }
  console.log(` Date:  ${event.fields["Event Date (Display)"]}`);
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
    console.log("          NOTE: --force does NOT override the Replied gate or");
    console.log("          the Cluster gate. Neither is ever what you meant.");
  }
  if (args.wave) console.log(` Wave:  ${args.wave} (only this wave)`);
  if (args.limit) console.log(` Limit: first ${args.limit} eligible partner(s) only`);
  console.log("");
  console.log(" NOTE: Draft Subject/Body in Airtable = a draft was made.");
  console.log("       It does NOT mean the email was sent. Stamp Touch N Sent");
  console.log("       yourself once you actually hit Send.");
  console.log("============================================================\n");

  // Registration URL is required, and required PER CYCLE. This is the check
  // that makes an unpopulated cycle fail loudly instead of quietly rendering
  // the previous cycle's RSVP link into every email.
  const missingEventFields = [
    "Portfolio Partner",
    "Event Hook",
    "Event Date (Display)",
    "Registration URL",
  ].filter((f) => !event.fields[f]);

  if (missingEventFields.length) {
    console.error(
      `Event "${args.eventSlug}" is missing: ${missingEventFields.join(", ")}.\n` +
        "Fill these in on the Events table before rendering."
    );
    process.exit(1);
  }

  // --- resolve the template(s) -----------------------------------------------
  //
  // Touch 1 may have SEVERAL active email templates. They split two ways:
  //   * By Lead Type: Warm (the single "really glad we got to talk" note) vs
  //     Cold (the "you kept coming up" cold open). A partner is routed by the
  //     Lead Type of the template it is linked to.
  //   * Within Cold, by ask type (Card / Referral Deal / Co-hosted Event / ...),
  //     distinguished by the template's "Ask" field.
  // Touch 2 and Touch 3 are ask-agnostic and Lead-Type-agnostic (their Lead Type
  // is blank, so they land in the cold bucket) with a single template each. The
  // Channel filter is still deliberate: without it a lookup by touch number
  // could grab the Phone or Instagram DM script, which are also Touch 1.

  const touchTemplates = templates.filter(
    (t) =>
      t.fields.Channel === "Email" &&
      Number(t.fields["Touch Number"]) === args.touch &&
      t.fields.Active === true
  );

  if (!touchTemplates.length) {
    console.error(
      `No ACTIVE Email template with Touch Number ${args.touch} in the Templates table.`
    );
    process.exit(1);
  }

  const isWarmTemplate = (t) =>
    String(t.fields["Lead Type"] || "").trim() === "Warm";
  const warmTemplate = touchTemplates.find(isWarmTemplate) || null;
  const coldTemplates = touchTemplates.filter((t) => !isWarmTemplate(t));

  // Index the COLD templates by Ask. A template with no Ask is treated as the
  // Card default, which is what keeps this backward-compatible: with today's
  // single, Ask-less card template, every cold partner resolves to it exactly as
  // before. The warm template is kept OUT of this map so its blank Ask does not
  // squat the Card slot.
  const templatesByAsk = new Map();
  for (const t of coldTemplates) {
    const ask = String(t.fields.Ask || "Card").trim();
    if (!templatesByAsk.has(ask)) templatesByAsk.set(ask, t);
  }
  const defaultTemplate = templatesByAsk.get("Card") || coldTemplates[0];

  if (!defaultTemplate) {
    console.error(
      `No ACTIVE Cold Email template with Touch Number ${args.touch}. Every touch needs at least a Card template.`
    );
    process.exit(1);
  }

  // Cold Touch 1 is chosen by the partner's PRIMARY ask, falling back to Card.
  // Touch 2 / Touch 3 are ask-agnostic, so every partner gets the one follow-up.
  const resolveTemplate = (bestAsk) => {
    if (args.touch !== 1) return defaultTemplate;
    return templatesByAsk.get(String(bestAsk || "Card").trim()) || defaultTemplate;
  };

  console.log(
    args.touch === 1
      ? `Touch 1 cold templates by ask: ${[...templatesByAsk.keys()].join(", ")}` +
          `\nTouch 1 warm template: ${warmTemplate ? warmTemplate.fields["Template Name"] : "none active"}\n`
      : `Template: ${defaultTemplate.fields["Template Name"]}\n`
  );

  const partnersById = new Map(partners.map((p) => [p.id, p]));
  const rows = outreach.filter((o) => {
    if (!(o.fields.Event || []).includes(event.id)) return false;
    if (!args.wave) return true;
    // --wave narrows to a single wave. Wave lives on the linked Partner row,
    // not on Outreach, so resolve it through partnersById first.
    const partnerId = (o.fields.Partner || [])[0];
    const partner = partnerId ? partnersById.get(partnerId) : null;
    return waveMatches(partner && partner.fields.Wave, args.wave);
  });
  console.log(
    `Outreach rows for this event${args.wave ? ` (wave: ${args.wave})` : ""}: ${rows.length}\n`
  );

  // --- sequence rules --------------------------------------------------------
  //
  // A touch is DUE for a partner when all of the following hold:
  //
  //   * They have not replied. A reply ends the sequence, full stop. This is
  //     the single most important gate here and its absence was a real bug —
  //     the earlier version would happily draft a day-8 nudge to someone who
  //     answered on day 2.
  //
  //   * This touch has not already been sent (Touch N Sent is blank).
  //
  //   * The PREVIOUS touch has been sent. You cannot follow up on an email
  //     that never went out. This is what makes draft-touch2 do nothing
  //     sensible on a cycle where Touch 1 is still sitting unsent in Gmail —
  //     which is correct, and is now reported rather than silently confusing.
  //
  //   * Enough days have passed since the previous touch was SENT. Not since
  //     it was drafted — drafts can sit for days. The interval comes from
  //     Templates."Send Offset (Days)": Touch 1 = 0, Touch 2 = 8, Touch 3 = 18.
  //     Those are offsets from Touch 1, so the wait for touch N is
  //     (offset N - offset N-1) days after touch N-1 actually went out.
  //
  // Draft Subject / Draft Body are NOT a gate. They are a preview of the most
  // recent render, overwritten each touch. Treating them as a gate is what
  // made draft-touch2 skip everybody: Touch 1 had filled them in.

  const DAY_MS = 24 * 60 * 60 * 1000;

  const offsetFor = (touchNumber) => {
    // Prefer the Card template when several email templates share a touch
    // number (Touch 1 has one per ask). They all carry the same Send Offset,
    // so any would do, but keeping it deterministic avoids surprises. The warm
    // template is excluded: its blank Ask reads as "Card" and it has no offset,
    // so it must not be allowed to answer for the cold sequence.
    const candidates = templates.filter(
      (x) =>
        x.fields.Channel === "Email" &&
        Number(x.fields["Touch Number"]) === touchNumber &&
        x.fields.Active === true &&
        String(x.fields["Lead Type"] || "").trim() !== "Warm"
    );
    const t =
      candidates.find((x) => String(x.fields.Ask || "Card").trim() === "Card") ||
      candidates[0];
    const raw = t && t.fields["Send Offset (Days)"];
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  };

  // How many days must elapse after touch N-1 is SENT before touch N is due.
  let requiredWaitDays = 0;
  if (args.touch > 1) {
    const thisOffset = offsetFor(args.touch);
    const prevOffset = offsetFor(args.touch - 1);
    if (thisOffset === null || prevOffset === null) {
      console.error(
        `Cannot compute the wait for touch ${args.touch}: "Send Offset (Days)" is missing on the Touch ${args.touch} or Touch ${args.touch - 1} Email template. Fill it in (0 / 8 / 18).`
      );
      process.exit(1);
    }
    requiredWaitDays = thisOffset - prevOffset;
    console.log(
      `Touch ${args.touch} is due ${requiredWaitDays} day(s) after Touch ${args.touch - 1} was sent.\n`
    );
  }

  const now = new Date();

  // --- render + gate ---------------------------------------------------------

  const eligible = [];
  const skippedNoPartner = [];
  const skippedHandwrite = [];
  const skippedClusterMember = [];
  const skippedNoDetail = [];
  const skippedNotEmail = [];
  const skippedNoAddress = [];
  const skippedReplied = [];
  const skippedTouchAlreadySent = [];
  const skippedPrevTouchNotSent = [];
  const skippedTooSoon = [];
  const skippedBadTokens = [];
  const skippedNoWarmTemplate = [];
  const skippedNoWarmAsk = [];

  // Partners whose City was blank and fell back to DEFAULT_CITY_PHRASE. Not a
  // skip and not an error — the email still reads correctly. Reported at the
  // end so a systematic gap in the City column is visible rather than silent.
  const usedCityFallback = [];

  for (const row of rows) {
    const partnerId = (row.fields.Partner || [])[0];
    const partner = partnerId ? partnersById.get(partnerId) : undefined;

    if (!partner) {
      skippedNoPartner.push(row.fields.Outreach || row.id);
      continue;
    }

    const p = partner.fields;
    const name = p.Name || partner.id;
    const o = row.fields;

    // Route cold vs warm by the Lead Type of the linked Target Template. No
    // link, or a link to a cold template, is cold. Warm routing is Touch 1 only
    // — the follow-ups are a single shared note.
    const linkedTemplateId = (p["Target Template"] || [])[0];
    const leadType = linkedTemplateId
      ? leadTypeByTemplateId.get(linkedTemplateId) || "Cold"
      : "Cold";
    const isWarm = args.touch === 1 && leadType === "Warm";

    // GATE 0 — HANDWRITE. Some partners must never receive an auto-generated
    // letter. When a business is celebrity-fronted or PR-managed and reached
    // through a marketing or events manager rather than the owner, the peer
    // "you kept coming up" template reads as false, and the ask must be
    // reframed by hand (Kann is the first). A checked Partners."Handwrite"
    // disables drafting for this row; the bespoke letter lives in Notes and is
    // sent by hand. --force does NOT override this. Shipping the wrong letter
    // is never what you meant.
    if (p.Handwrite) {
      skippedHandwrite.push(name);
      continue;
    }

    // GATE 1 — CLUSTERS. One human, multiple rooms, ONE letter.
    //
    // Airtable holds one row per BUSINESS. Some people own more than one:
    //
    //   Osbaldo Hernandez & Dennis Ramey -> El Sueñito + Frelard Tamales
    //   Jody Hall                        -> Cupcake Royale + Wunderground
    //   Nat Stratton-Clarke              -> Cafe Flora + Floret
    //
    // Without this gate, each of those people receives TWO cold emails on the
    // same morning, addressed to two of their own businesses, each claiming
    // the other "kept coming up" during months of careful research. That is
    // the fastest way in existence to be read as a mail merge, and it destroys
    // the exact thing the Specific Detail is built to prove.
    //
    // The Lead's copy names BOTH rooms, so a yes covers both.
    //
    // --force does NOT override this. There is no situation in which sending
    // one person two cold letters is the thing you meant to do.
    if (p.Cluster && !p["Cluster Lead"]) {
      skippedClusterMember.push(`${name} (cluster: ${p.Cluster})`);
      continue;
    }

    // GATE 2 — THEY REPLIED. Stop. Nothing below this matters.
    // --force does not override this either. There is no version of "they
    // answered you, so send the follow-up anyway" that is correct.
    if (o.Replied) {
      skippedReplied.push(`${name} (replied ${o.Replied})`);
      continue;
    }

    // GATE 3 — this touch already went out.
    const thisTouchSent = o[`Touch ${args.touch} Sent`];
    if (thisTouchSent && !args.force) {
      skippedTouchAlreadySent.push(`${name} (sent ${thisTouchSent})`);
      continue;
    }

    // GATE 4 — the previous touch has to have been SENT, and long enough ago.
    if (args.touch > 1) {
      const prevSentRaw = o[`Touch ${args.touch - 1} Sent`];

      if (!prevSentRaw) {
        skippedPrevTouchNotSent.push(name);
        continue;
      }

      const prevSent = new Date(prevSentRaw);
      const daysElapsed = Math.floor((now - prevSent) / DAY_MS);

      if (daysElapsed < requiredWaitDays && !args.force) {
        const dueIn = requiredWaitDays - daysElapsed;
        skippedTooSoon.push(
          `${name} (touch ${args.touch - 1} sent ${daysElapsed}d ago; due in ${dueIn}d)`
        );
        continue;
      }
    }

    // GATE 5 — the quality gate, COLD ONLY. A blank Specific Detail means nobody
    // has found one true, sourced thing to say about this business. Skipped
    // rather than padded with filler. The blank is a feature. The WARM note does
    // not use Specific Detail — its proof is the meeting that already happened —
    // so a warm partner is never gated on it.
    if (!isWarm && !p["Specific Detail"]) {
      skippedNoDetail.push(name);
      continue;
    }

    // GATE 6 — channel.
    if (p["Contact Method"] !== "Email") {
      skippedNotEmail.push(`${name} (${p["Contact Method"] || "no method set"})`);
      continue;
    }

    if (!p.Email) {
      skippedNoAddress.push(name);
      continue;
    }

    // --- build tokens + render, per register ---------------------------------

    let template;
    let subject;
    let body;

    if (isWarm) {
      // WARM. "Really glad we got to talk ..." to someone Jess has already met.
      if (!warmTemplate) {
        skippedNoWarmTemplate.push(name);
        continue;
      }

      // The ask sentence comes whole from Ask Snippets, keyed by Best Ask.
      // No match = skip loudly rather than mail a body with a hole in it.
      const askSentence = askSentenceByAsk[String(p["Best Ask"] || "Card").trim()];
      if (!askSentence) {
        skippedNoWarmAsk.push(`${name} (${p["Best Ask"] || "no Best Ask"})`);
        continue;
      }

      const identityLine =
        identityLineByOwnership[p["Ownership"]] ||
        identityLineByOwnership["Unverified"] ||
        "";
      const memoryJog = computeMemoryJog(p["Last Interaction"] || p["Met Date"]);
      const callback = p["Callback"] || "";

      // {Callback} and {Memory Jog} are blank-safe and must DISAPPEAR when empty
      // rather than trip the unresolved-token assert, so they are spliced in
      // before render — the same trick used for {Secondary Ask Line}.
      const spliceWarm = (str) =>
        String(str || "")
          .split("{Callback}")
          .join(callback)
          .split("{Memory Jog}")
          .join(memoryJog);

      const tokens = {
        "Greeting Name": p["Greeting Name"] || "there",
        "Partner Name": p.Name,
        "Meeting Context": p["Meeting Context"],
        "Identity Line": identityLine,
        "Ask Sentence": askSentence,
      };

      template = warmTemplate;
      subject = renderDeep(spliceWarm(template.fields["Subject Template"]), tokens);
      body = renderDeep(spliceWarm(template.fields["Body Template"]), tokens);
    } else {
      // COLD. "You kept coming up." The opener clause and its nested {City} come
      // from the Opener & Identity Lines table, keyed by Ownership.
      if (!p.City) usedCityFallback.push(name);

      const secondaryAskLine = SECONDARY_ASK_LINES[p["Secondary Ask"]] || "";

      // The consolidated cold favor template carries {Cold Ask Block} (the whole
      // ask paragraph, keyed by Best Ask) and a blank-safe {Cold Ask Closer}
      // (only the Card ask sets one). Referral Deal and Introducer keep their own
      // full templates and simply do not contain these tokens, so the lookup is
      // harmless for them. Unknown or blank ask falls back to Card.
      const coldAsk =
        coldAskByAsk[String(p["Best Ask"] || "Card").trim()] ||
        coldAskByAsk["Card"] || { block: "", closer: "" };

      // {Cold Ask Closer} and {Secondary Ask Line} are blank-safe and must
      // DISAPPEAR when empty rather than trip the unresolved-token assert, so
      // both are spliced in before render.
      const spliceCold = (str) =>
        String(str || "")
          .split("{Secondary Ask Line}")
          .join(secondaryAskLine)
          .split("{Cold Ask Closer}")
          .join(coldAsk.closer || "");

      const cityPhrase = p.City || DEFAULT_CITY_PHRASE;

      // {Opener Clause} is entity-aware. An Organization (nonprofit, league,
      // congregation, agency) must NOT be called a "business" in the very
      // sentence whose job is proving the email is not a blast (the 9.9
      // mislabeled-entity error). Business (the blank default) gets "researching
      // the ... businesses around {City}"; Organization gets "getting to know
      // the ... corners of {City}". Both variants are keyed by Ownership and
      // carry a nested {City}. The org variant falls back to the business one if
      // a row is missing it, and either falls back to the Unverified row.
      const isOrganization =
        String(p["Entity Type"] || "").trim() === "Organization";
      const businessOpener =
        openerClauseByOwnership[p["Ownership"]] ||
        openerClauseByOwnership["Unverified"] ||
        "";
      const orgOpener =
        openerClauseOrgByOwnership[p["Ownership"]] ||
        openerClauseOrgByOwnership["Unverified"] ||
        "";
      const openerClause = (isOrganization ? orgOpener : businessOpener) || businessOpener;

      const tokens = {
        "Greeting Name": p["Greeting Name"] || "there",
        "Partner Name": p.Name,
        "Specific Detail": p["Specific Detail"],
        City: cityPhrase,
        "Event Date": event.fields["Event Date (Display)"],
        "Event Portfolio": event.fields["Portfolio Partner"],
        "Event Hook": event.fields["Event Hook"],
        "Registration URL": event.fields["Registration URL"],
        "Opener Clause": openerClause, // contains a nested {City}; renderDeep resolves it
        "Cold Ask Block": coldAsk.block, // the whole ask paragraph, keyed by Best Ask
      };

      // Per-partner template, chosen by primary ask (Touch 1). See resolveTemplate.
      // With the consolidated set, Card / Newsletter / Social Post / Co-hosted
      // Event all resolve to the single favor template (Card is the default), and
      // {Cold Ask Block} supplies the ask. Referral Deal and Introducer still map
      // to their own templates.
      template = resolveTemplate(p["Best Ask"]);
      subject = renderDeep(spliceCold(template.fields["Subject Template"]), tokens);
      body = renderDeep(spliceCold(template.fields["Body Template"]), tokens);
    }

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

  // Handwrite holds are deliberate, not errors — reported first so nobody
  // "fixes" a skip that is working as designed.
  reportSkips(
    "HANDWRITE — bespoke letter, auto-draft disabled",
    skippedHandwrite,
    "on purpose (celebrity / PR-managed rows). Send the hand-written letter saved on the Partner row"
  );

  // The cluster gate first, because it is the one whose absence would be
  // catastrophic and whose presence looks, at a glance, like a bug.
  reportSkips(
    "CLUSTER MEMBER, not the Lead",
    skippedClusterMember,
    "the Lead's letter covers this room too. This is deliberate, not a bug"
  );

  // Sequence skips next — on a touch-2 or touch-3 run these are the numbers
  // that explain the result, and "0 eligible" is usually correct rather than
  // broken.
  reportSkips(
    "REPLIED",
    skippedReplied,
    "the sequence ends on a reply. --force does not override this"
  );
  reportSkips(
    `touch ${args.touch} already sent`,
    skippedTouchAlreadySent,
    "nothing to do"
  );
  reportSkips(
    `touch ${args.touch - 1} not sent yet`,
    skippedPrevTouchNotSent,
    args.touch > 1
      ? `send touch ${args.touch - 1} and stamp "Touch ${args.touch - 1} Sent" first`
      : ""
  );
  reportSkips(
    "not due yet",
    skippedTooSoon,
    "come back on the date shown, or --force to draft early"
  );

  reportSkips(
    "no Specific Detail",
    skippedNoDetail,
    "the quality gate, working as designed. Write one sourced sentence or leave them out"
  );
  reportSkips(
    "warm partner, no matching Ask Snippet",
    skippedNoWarmAsk,
    "add an Assembled Example for this Best Ask in Ask Snippets, or fix the partner's Best Ask"
  );
  reportSkips(
    "warm partner, no active warm template",
    skippedNoWarmTemplate,
    "activate the Lead Type = Warm Touch 1 template in Templates"
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
  reportSkips("no linked Partner", skippedNoPartner, "broken Outreach row");
  reportSkips("UNRESOLVED TOKENS", skippedBadTokens, "template or Event data is incomplete");

  // Not a skip. These drafted fine, but their City cell is empty, so the email
  // says "around the Puget Sound area" instead of naming their town. Fixable
  // in ten seconds in Airtable, and worth knowing about before you send.
  if (usedCityFallback.length) {
    console.log(
      `Note — no City set, fell back to "${DEFAULT_CITY_PHRASE}" (${usedCityFallback.length}):`
    );
    usedCityFallback.forEach((n) => console.log(`  - ${n}`));
    console.log("  These still drafted. Set City in Airtable to name their town.\n");
  }

  console.log(`Eligible for drafting: ${eligible.length}`);
  if (args.limit) console.log(`Processing this run:   ${toProcess.length}`);
  console.log("");

  // Zero eligible on a follow-up run is the normal, healthy state most days.
  // Say so, rather than leaving a blank screen that reads like a failure.
  if (eligible.length === 0 && args.touch > 1) {
    console.log(
      `Nobody is due for touch ${args.touch} today. That is usually correct —\n` +
        "the follow-up only opens once the previous touch has actually been sent\n" +
        "and the waiting period has passed, and it closes the moment they reply.\n"
    );
  }

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
