#!/usr/bin/env node
/**
 * scripts/current-event.js
 *
 * Resolves the ACTIVE CYCLE from Airtable. Usable two ways:
 *
 *   As a CLI (prints the slug, nothing else — safe to shell-interpolate):
 *     node scripts/current-event.js            -> celebrity-alaska
 *     node scripts/current-event.js --verbose  -> slug + human-readable detail on stderr
 *
 *   As a module (no extra Airtable round-trip — pass in rows you already have):
 *     const { resolveCurrentEvent } = require("./current-event");
 *     const event = resolveCurrentEvent(events);
 *
 * THE RULE
 * --------
 * The active cycle is the earliest event whose "Event Start (UTC)" is still in
 * the future. Rollover happens at the instant the Zoom is scheduled to begin —
 * not end of day, not the next morning. At 6:00:01pm PT on Sept 22, the active
 * cycle is Virgin Voyages.
 *
 * This works because outreach always runs AHEAD of its event (touches at day
 * 0 / 8 / 18, event roughly six weeks out), so "next upcoming event" and "the
 * cycle I am currently working" are the same thing.
 *
 * WHY AIRTABLE AND NOT A HARDCODED DATE
 * --------------------------------------
 * "Event Start (UTC)" is already the field the tier-detection Zap computes its
 * Full/Mid/FinalDay/LastCall cutoffs from. Deriving the active cycle from the
 * same field means one source of truth. A second copy of the calendar living in
 * .zshrc is a copy that will eventually disagree with the first one, silently,
 * on the day it matters most.
 *
 * WHEN THE SERIES RUNS OUT
 * -------------------------
 * After the last event's start time passes, there is no future event and this
 * FAILS LOUDLY rather than defaulting to something. Silently falling back to
 * the last event would mean drafting Rocky Mountaineer outreach in January to a
 * cycle that already happened. An error you have to read is the correct
 * behavior here.
 */

const fs = require("fs");
const path = require("path");

const BASE_ID = "appv81raB2A2g9x1Y";
const EVENTS_TABLE = "tbl8I56RgDqgXFpQ5"; // Events — immutable ID, never the name

const EVENT_FIELDS = [
  "Event Name",
  "Slug",
  "Event Start (UTC)",
  "Portfolio Partner",
  "Event Hook",
  "Event Date (Display)",
  "Registration URL",
];

// ---------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------

/**
 * @param {Array} events  Airtable Events records
 * @param {Date}  now     defaults to the current moment
 * @returns {Object} the Airtable record for the active cycle
 * @throws if no event has a parseable future start
 */
function resolveCurrentEvent(events, now = new Date()) {
  const dated = [];

  for (const e of events) {
    const raw = e.fields["Event Start (UTC)"];
    if (!raw) continue;

    const start = new Date(raw);
    if (Number.isNaN(start.getTime())) {
      console.error(
        `WARNING: Event "${e.fields["Event Name"] || e.id}" has an unparseable ` +
          `Event Start (UTC): "${raw}". Expected ISO 8601, e.g. 2026-09-23T01:00:00Z. Ignoring this row.`
      );
      continue;
    }
    dated.push({ record: e, start });
  }

  if (!dated.length) {
    throw new Error(
      "No Events row has a usable Event Start (UTC). Cannot resolve the active cycle."
    );
  }

  const upcoming = dated
    .filter((d) => d.start > now)
    .sort((a, b) => a.start - b.start);

  if (!upcoming.length) {
    const last = dated.sort((a, b) => b.start - a.start)[0];
    throw new Error(
      "No upcoming event. The most recent was " +
        `"${last.record.fields["Event Name"]}" (${last.start.toISOString()}), ` +
        "which has already started.\n" +
        "Add the next cycle to the Events table, or pass --event=<slug> explicitly."
    );
  }

  return upcoming[0].record;
}

// ---------------------------------------------------------------------------
// CLI plumbing (only used when run directly)
// ---------------------------------------------------------------------------

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

async function fetchEvents(apiKey) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${EVENTS_TABLE}`);
    for (const f of EVENT_FIELDS) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
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

async function cli() {
  loadDotEnv();

  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    console.error("AIRTABLE_API_KEY is not set. Add it to .env in the repo root.");
    process.exit(1);
  }

  const verbose = process.argv.includes("--verbose");

  let event;
  try {
    event = resolveCurrentEvent(await fetchEvents(apiKey));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Detail goes to stderr so that `$(node scripts/current-event.js)` captures
  // ONLY the slug on stdout, even in verbose mode.
  if (verbose) {
    const f = event.fields;
    console.error(
      `Active cycle: ${f["Event Name"]}\n` +
        `  Portfolio:  ${f["Portfolio Partner"] || "(not set)"}\n` +
        `  Date:       ${f["Event Date (Display)"] || "(not set)"}\n` +
        `  RSVP page:  ${f["Registration URL"] || "(NOT SET — drafting will refuse to run)"}\n` +
        `  Starts:     ${f["Event Start (UTC)"]}\n` +
        `  Rolls over to the next cycle at that instant.`
    );
  }

  process.stdout.write(event.fields.Slug + "\n");
}

module.exports = { resolveCurrentEvent, EVENT_FIELDS, EVENTS_TABLE, BASE_ID };

if (require.main === module) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
