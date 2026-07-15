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
 *
 * TOKENS (filled per partner, per cycle):
 *   {Greeting Name} {Partner Name} {Specific Detail}
 *   {Event Date} {Event Portfolio} {Event Hook} {Registration URL}
 *   {City}             <- Partners.City, else DEFAULT_CITY_PHRASE. Not a gate.
 *   {Community Phrase} <- Partners.Ownership. "Queer-owned (verified)" earns the
 *                         pointed "queer-owned"; everyone else gets the inclusive
 *                         "queer-owned and queer-loved". NEVER claim ownership we
 *                         cannot verify (the Metier / Browsers failure).
 *   {Opener Clause}    <- Partners.Entity Type. Business (default) -> "researching
 *                         the <phrase> businesses around <city>"; Organization ->
 *                         "getting to know the <phrase> corners of <city>", because
 *                         "businesses" is false for a nonprofit / league / agency.
 *                         ORTHOGONAL to Best Ask: a queer-owned business acting as
 *                         an introducer keeps the business opener; an org with a
 *                         newsletter ask still gets the org opener.
 *   {Secondary Ask Line} <- Partners.Secondary Ask, via SECONDARY_ASK_LINES.
 *                         Blank-safe: spliced in BEFORE render() so an empty one
 *                         vanishes instead of tripping the unresolved-token gate.
 *
 * TEMPLATE SELECTION: Touch 1 is chosen PER PARTNER by Partners.Best Ask matched
 *   to Templates.Ask (Card / Referral Deal / Co-hosted Event / Newsletter /
 *   Social Post / Introducer). A template with no Ask = Card, so it stays
 *   backward-compatible. Touch 2 and Touch 3 are ask-agnostic (one of each serves
 *   everyone). The Channel filter is deliberate: without it a touch lookup could
 *   grab the Phone or Instagram DM script, which are also Touch 1.
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
 *   --event=<slug>  override the auto-selected cycle
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
 *   quality gate — a blank means no sourced sentence was found, and skipping beats
 *   filler); Contact Method != Email (route to the Phone / Instagram DM copy);
 *   missing address. Plus a HARD ASSERT: if any {Token} survives rendering, the
 *   row is skipped rather than mailed broken.
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
// "researching queer-owned businesses around the Pacific Northwest" is
// accurate for every partner in this base.
//
// So a missing City degrades gracefully rather than killing an otherwise good
// row. It reads correctly in the slot it lands in, which is:
//
//   "...researching queer-owned businesses around {City} while I was getting
//    my own travel practice ready to launch."
const DEFAULT_CITY_PHRASE = "the Pacific Northwest";

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

// The {Community Phrase} token — Option B. The opener says either "queer-owned"
// (recognition, for a business VERIFIED queer-owned from its own words) or
// "queer-owned and queer-loved" (true for an ally, or a row not yet verified).
// Never claim ownership we cannot verify: that is the Metier / Browsers failure
// in Appendix A. Only "Queer-owned (verified)" earns the pointed phrase.
const COMMUNITY_PHRASE_BY_OWNERSHIP = {
  "Queer-owned (verified)": "queer-owned",
};
const DEFAULT_COMMUNITY_PHRASE = "queer-owned and queer-loved";

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

  console.log("Fetching from Airtable...");
  const [events, partners, templates, outreach] = await Promise.all([
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
      "Best Ask", // selects the Touch 1 template by ask type. Fallback: Card.
      "Secondary Ask", // fills {Secondary Ask Line}. Blank -> token renders empty.
      "Ownership", // fills {Community Phrase}. Verified queer-owned -> pointed opener.
      "Entity Type", // fills {Opener Clause}. Organization -> "corners of", else "businesses around".
      "Handwrite", // GATE 0: checked = skip auto-drafting entirely; bespoke hand-written letter (see Notes).
    ]),
    fetchAll(TABLES.templates, [
      "Template Name",
      "Touch Number",
      "Channel",
      "Ask", // which ask this template voices. Matched against partner Best Ask.
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
  ]);

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
  // Touch 1 may have SEVERAL active email templates, one per ask type
  // (Card / Referral Deal / Co-hosted Event / ...), distinguished by the
  // template's "Ask" field. Touch 2 and Touch 3 are ask-agnostic and have a
  // single template each. The Channel filter is still deliberate: without it a
  // lookup by touch number could grab the Phone or Instagram DM script, which
  // are also Touch 1.

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

  // Index by Ask. A template with no Ask is treated as the Card default, which
  // is what keeps this backward-compatible: with today's single, Ask-less card
  // template, every partner resolves to it exactly as before.
  const templatesByAsk = new Map();
  for (const t of touchTemplates) {
    const ask = String(t.fields.Ask || "Card").trim();
    if (!templatesByAsk.has(ask)) templatesByAsk.set(ask, t);
  }
  const defaultTemplate = templatesByAsk.get("Card") || touchTemplates[0];

  // Touch 1 is chosen by the partner's PRIMARY ask, falling back to Card.
  // Touch 2 / Touch 3 are ask-agnostic, so every partner gets the one follow-up.
  const resolveTemplate = (bestAsk) => {
    if (args.touch !== 1) return defaultTemplate;
    return templatesByAsk.get(String(bestAsk || "Card").trim()) || defaultTemplate;
  };

  console.log(
    args.touch === 1
      ? `Touch 1 templates available by ask: ${[...templatesByAsk.keys()].join(", ")}\n`
      : `Template: ${defaultTemplate.fields["Template Name"]}\n`
  );

  const partnersById = new Map(partners.map((p) => [p.id, p]));
  const rows = outreach.filter((o) => (o.fields.Event || []).includes(event.id));
  console.log(`Outreach rows for this event: ${rows.length}\n`);

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
    // so any would do, but keeping it deterministic avoids surprises.
    const candidates = templates.filter(
      (x) =>
        x.fields.Channel === "Email" &&
        Number(x.fields["Touch Number"]) === touchNumber &&
        x.fields.Active === true
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

    // GATE 5 — the quality gate. A blank Specific Detail means nobody has
    // found one true, sourced thing to say about this business. Skipped rather
    // than padded with filler. The blank is a feature.
    if (!p["Specific Detail"]) {
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

    // {City} is NOT a gate. A blank City degrades to DEFAULT_CITY_PHRASE, which
    // keeps the sentence true, rather than skipping a partner who has a good
    // sourced detail and a working email address over a missing metadata field.
    if (!p.City) usedCityFallback.push(name);

    // The Secondary Ask line, substituted directly (not via the generic token
    // renderer). This matters: render() leaves an EMPTY-valued token literal so
    // it gets caught by the unresolved-token assert. A blank Secondary Ask must
    // instead disappear cleanly, so it is spliced in here, before render runs.
    const secondaryAskLine = SECONDARY_ASK_LINES[p["Secondary Ask"]] || "";
    const spliceSecondary = (str) =>
      String(str || "").split("{Secondary Ask Line}").join(secondaryAskLine);

    const communityPhrase =
      COMMUNITY_PHRASE_BY_OWNERSHIP[p["Ownership"]] || DEFAULT_COMMUNITY_PHRASE;
    const cityPhrase = p.City || DEFAULT_CITY_PHRASE;

    // {Opener Clause} — the entity-aware first clause of the opener sentence.
    //
    //   Business (default):  "researching the <phrase> businesses around <city>"
    //   Organization:        "getting to know the <phrase> corners of <city>"
    //
    // An Organization (nonprofit, league, congregation, community center,
    // chapter, public agency) must not be called a "business" in the very
    // sentence whose job is proving the email is not a blast. Driven by
    // Partners."Entity Type", which defaults to Business when blank.
    //
    // This is ORTHOGONAL to Best Ask, and that is the point: a queer-owned
    // business acting as an introducer (BAX) keeps the business opener, and an
    // organization whose ask is a newsletter mention (Seattle Choruses, Emerald
    // City Softball) still gets the org opener. Ask type alone could not tell
    // those apart, which is exactly the edge case this token closes.
    const isOrganization =
      String(p["Entity Type"] || "").trim() === "Organization";
    const openerClause = isOrganization
      ? `getting to know the ${communityPhrase} corners of ${cityPhrase}`
      : `researching the ${communityPhrase} businesses around ${cityPhrase}`;

    const tokens = {
      "Greeting Name": p["Greeting Name"] || "there",
      "Partner Name": p.Name,
      "Specific Detail": p["Specific Detail"],
      City: cityPhrase,
      "Event Date": event.fields["Event Date (Display)"],
      "Event Portfolio": event.fields["Portfolio Partner"],
      "Event Hook": event.fields["Event Hook"],
      "Registration URL": event.fields["Registration URL"],
      "Community Phrase": communityPhrase,
      "Opener Clause": openerClause,
    };

    // Per-partner template, chosen by primary ask (Touch 1). See resolveTemplate.
    const template = resolveTemplate(p["Best Ask"]);

    const subject = render(spliceSecondary(template.fields["Subject Template"]), tokens);
    const body = render(spliceSecondary(template.fields["Body Template"]), tokens);

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
  // says "around the Pacific Northwest" instead of naming their town. Fixable
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
