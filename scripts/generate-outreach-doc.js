#!/usr/bin/env node
/**
 * generate-outreach-doc.js  —  the copy-paste companion to generate-gmail-drafts.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Gmail generator handles Contact Method = Email. But a large slice of the
 * roster has NO email: Instagram-only businesses, phone-only shops, and rooms
 * whose only front door is a contact form. Those cannot become Gmail drafts.
 *
 * There is also NO compliant way to SEND their messages for them. Researched
 * 2026-07-14: the official Instagram Messaging (Send) API can only message a
 * user within 24 hours AFTER that user messages you first — it cannot initiate
 * a cold DM. Third-party "DM automation" tools drive the app against Meta's
 * terms and get accounts banned (2026 caps: ~200 automated DMs/hour, 1 DM per
 * user per 24h). No Instagram MCP connector exists either. So the correct,
 * safe, on-brand move is: RENDER the copy, and Jess pastes it in by hand. That
 * is also what the three-touch, peer-to-peer doctrine wants anyway.
 *
 * WHAT IT DOES
 * ------------
 * For the active cycle, it renders every NON-EMAIL partner's Touch-1 outreach,
 * grouped by channel, into a FORMATTED GOOGLE DOC in your Drive (and prints the
 * link). Pass --md to write a local Markdown file instead.
 *
 *   Instagram DM  -> the two-message "Instagram DM — Short Form" script
 *   Phone Only    -> the "Phone — Walk-In Booking Call" script
 *   Contact Form  -> the ask-variant EMAIL body (you paste it into their form)
 *   None Found    -> the "In Person — The Drop-By" script (presence is the proof)
 *
 * It shares the Gmail generator's token logic EXACTLY, so the opener stays
 * correct everywhere: {Opener Clause} (Business vs Organization), {Community
 * Phrase} (verified queer-owned vs inclusive), {Specific Detail}, {City}, and
 * the blank-safe {Secondary Ask Line}. Same gates, too: cluster members who are
 * not the Lead are skipped, replied partners are skipped, and a blank Specific
 * Detail skips the row (except In Person, where no detail is required).
 *
 * It reads Airtable and CREATES A GOOGLE DOC (or a local file). It sends
 * nothing and stamps nothing in Airtable.
 *
 * USAGE
 * -----
 *   node scripts/generate-outreach-doc.js
 *       Active cycle -> a new formatted Google Doc in your Drive. Prints the URL.
 *   node scripts/generate-outreach-doc.js --md
 *       Write ./outreach-copy-<slug>.md locally instead of a Google Doc.
 *   node scripts/generate-outreach-doc.js --event=celebrity-alaska
 *       Override the auto-selected cycle.
 *   node scripts/generate-outreach-doc.js --instagram
 *       One channel. Flags: --instagram (--ig | --dm), --phone,
 *       --in-person, --contact-form (--form). No flag at all = every channel.
 *   node scripts/generate-outreach-doc.js --phone --in-person
 *       A combo — just stack the flags, any mix.
 *   node scripts/generate-outreach-doc.js --folder=<driveFolderId>
 *       Create the Doc inside a specific Drive folder instead of My Drive root.
 *   (The older --channel=instagram,phone form still works too.)
 *
 * SETUP
 * -----
 * .env needs AIRTABLE_API_KEY (same as the Gmail generator).
 *
 * Google Doc output reuses your existing credentials.json (the same OAuth
 * desktop client as the Gmail script) but needs the Drive scope, so the FIRST
 * run opens a browser to authorize and writes a SEPARATE token-docs.json. This
 * is deliberately a different token file from the Gmail script's token.json, so
 * the two never clobber each other's scopes. Scope requested is drive.file,
 * which only grants access to files THIS app creates — it cannot see the rest
 * of your Drive. Add token-docs.json to .gitignore. If you would rather not
 * involve Google at all, use --md.
 */

const fs = require("fs");
const path = require("path");
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
  console.error("AIRTABLE_API_KEY is not set. Add it to your .env file in the repo root.");
  process.exit(1);
}

const BASE_ID = "appv81raB2A2g9x1Y";

// Kept byte-identical to generate-gmail-drafts.js so the two never drift.
const DEFAULT_CITY_PHRASE = "the Pacific Northwest";
const COMMUNITY_PHRASE_BY_OWNERSHIP = { "Queer-owned (verified)": "queer-owned" };
const DEFAULT_COMMUNITY_PHRASE = "queer-owned and queer-loved";
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

const TABLES = {
  events: "tbl8I56RgDqgXFpQ5",
  partners: "tblFlH8ssP07XdrhZ",
  outreach: "tblstWlG7RC3R4fRA",
  templates: "tblwww889pqm5NAGE",
};

const apiRoot = (tableId) => `https://api.airtable.com/v0/${BASE_ID}/${tableId}`;

// Google Doc auth — reuses the Gmail script's credentials.json, but a SEPARATE
// token file, because the scope is different (Drive, not Gmail). drive.file =
// this app can only touch files it creates. It cannot read the rest of Drive.
const REPO_ROOT = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(REPO_ROOT, "credentials.json");
const DOCS_TOKEN_PATH = path.join(REPO_ROOT, "token-docs.json");
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// Which non-email channels this doc covers, and which template Channel + Touch
// each one renders from. Email is deliberately absent — that is the Gmail
// generator's job. Contact Form is special: there is no "Contact Form"
// template, because the thing you paste into the form IS the ask-variant email
// body, chosen by Best Ask. It is handled below, not here.
const CHANNEL_RENDER = {
  "Instagram DM": { templateChannel: "Instagram DM", touch: 1, detailOptional: false },
  "Phone Only": { templateChannel: "Phone", touch: 1, detailOptional: false },
  "None Found": { templateChannel: "In Person", touch: 2, detailOptional: true },
};

// --channel accepts friendly aliases so you never have to type the exact
// Contact Method value. Each alias (spaces/hyphens/case ignored) maps to a
// Contact Method. "in-person" is the "None Found" rows, because a partner with
// no other way in gets the in-person drop-by.
const CHANNEL_ALIASES = {
  instagram: "Instagram DM",
  ig: "Instagram DM",
  dm: "Instagram DM",
  instagramdm: "Instagram DM",
  phone: "Phone Only",
  phoneonly: "Phone Only",
  inperson: "None Found",
  none: "None Found",
  nonefound: "None Found",
  dropby: "None Found",
  contactform: "Contact Form",
  form: "Contact Form",
};

// Boolean channel flags — the easy-to-remember form. Stack them for a combo.
const CHANNEL_FLAGS = {
  "--instagram": "Instagram DM",
  "--ig": "Instagram DM",
  "--dm": "Instagram DM",
  "--instagram-dm": "Instagram DM",
  "--phone": "Phone Only",
  "--in-person": "None Found",
  "--inperson": "None Found",
  "--drop-by": "None Found",
  "--contact-form": "Contact Form",
  "--form": "Contact Form",
};

// Build the Set of Contact Method values to keep, from the boolean channel flags
// (--instagram, --phone, --in-person, --contact-form) AND/OR the older
// --channel=alias,alias form. Both can be combined. Returns null when nothing
// was passed, which means: every non-email channel.
function resolveChannelFilter(argv, channelStr) {
  const wanted = new Set();
  for (const a of argv) if (CHANNEL_FLAGS[a]) wanted.add(CHANNEL_FLAGS[a]);
  if (channelStr) {
    for (const token of String(channelStr).split(",")) {
      const key = token.trim().toLowerCase().replace(/[\s-]/g, "");
      if (!key) continue;
      const cm = CHANNEL_ALIASES[key];
      if (!cm) {
        console.error(
          `Unknown --channel "${token.trim()}". Valid: instagram, phone, in-person, contact-form.`
        );
        process.exit(1);
      }
      wanted.add(cm);
    }
  }
  return wanted.size ? wanted : null;
}

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
      throw new Error(`Airtable fetch failed for ${tableId}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

function render(template, tokens) {
  return String(template || "").replace(/\{([^}]+)\}/g, (match, key) => {
    const value = tokens[key.trim()];
    return value === undefined || value === null || value === "" ? match : value;
  });
}

function findUnresolvedTokens(...rendered) {
  const found = new Set();
  for (const text of rendered) for (const m of text.matchAll(/\{[^}]+\}/g)) found.add(m[0]);
  return [...found];
}

function parseArgs(argv) {
  const getEq = (name) => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`));
    return flag ? flag.split("=").slice(1).join("=") : undefined;
  };
  return {
    eventSlug: getEq("event"),
    channel: getEq("channel"), // optional filter: aliases, comma-separated. See resolveChannelFilter.
    folder: getEq("folder"), // optional Drive folder ID
    md: argv.includes("--md"), // write a local Markdown file instead of a Google Doc
  };
}

// ---------------------------------------------------------------------------
// output builders
// ---------------------------------------------------------------------------

const CHANNEL_ORDER = ["Instagram DM", "Phone Only", "Contact Form", "None Found"];

const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildHtml(event, rendered, skips) {
  const labels = Object.keys(rendered).sort(
    (a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)
  );
  const out = [];
  out.push(`<h1>Non-email outreach — ${escHtml(event.fields["Event Name"])}</h1>`);
  out.push(
    `<p>Copy each block into the channel named in its heading. This document sends nothing.</p>`
  );
  out.push(
    `<p><i>Instagram cannot be automated for cold DMs (Meta's API only allows replies within 24 hours of the person messaging you first), so these are rendered for you to paste by hand.</i></p>`
  );
  out.push(`<p>Cycle date: ${escHtml(event.fields["Event Date (Display)"])}</p>`);

  for (const label of labels) {
    const items = rendered[label];
    out.push(`<hr/>`);
    out.push(`<h1>${escHtml(label)} (${items.length})</h1>`);
    for (const it of items) {
      const link = it.link ? ` &middot; <a href="${escHtml(it.link)}">${escHtml(it.link)}</a>` : "";
      const city = it.city ? ` &middot; ${escHtml(it.city)}` : "";
      out.push(`<h2>${escHtml(it.name)}${city}${link}</h2>`);
      // <pre> keeps line breaks and imports as a monospace block: a clear visual
      // "select and copy this" signal, and no smart-quote mangling on paste.
      out.push(`<pre>${escHtml(it.text)}</pre>`);
    }
  }

  const skipBlock = (title, list) => {
    if (!list.length) return;
    out.push(`<hr/>`);
    out.push(`<h2>Skipped — ${escHtml(title)} (${list.length})</h2>`);
    out.push(`<ul>${list.map((n) => `<li>${escHtml(n)}</li>`).join("")}</ul>`);
  };
  skipBlock("cluster member, not the Lead (the Lead's outreach covers them)", skips.cluster);
  skipBlock("already replied", skips.replied);
  skipBlock("no Specific Detail (write one or reach in person)", skips.noDetail);
  skipBlock("no template for this channel", skips.noTemplate);
  skipBlock("UNRESOLVED TOKENS (fix the template or Event data)", skips.badTokens);

  return `<html><body>${out.join("\n")}</body></html>`;
}

function buildMarkdown(event, rendered, skips) {
  const labels = Object.keys(rendered).sort(
    (a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)
  );
  const lines = [];
  lines.push(`# Non-email outreach — ${event.fields["Event Name"]}`, "");
  lines.push(`Copy each block into the channel named in its heading. This file sends nothing.`);
  lines.push(
    `Instagram cannot be automated for cold DMs (Meta's API only allows replies within 24h of the person messaging you first), so these are rendered for you to paste by hand.`,
    ""
  );
  lines.push(`Cycle date: ${event.fields["Event Date (Display)"]}`, "");
  for (const label of labels) {
    const items = rendered[label];
    lines.push(`\n---\n`, `## ${label} (${items.length})`);
    for (const it of items) {
      const meta = [it.city, it.link].filter(Boolean).join("  ·  ");
      lines.push("", `### ${it.name}${meta ? `  ·  ${meta}` : ""}`, "", "```", it.text, "```");
    }
  }
  const skipBlock = (title, list) => {
    if (!list.length) return;
    lines.push(`\n---\n`, `## Skipped — ${title} (${list.length})`);
    for (const n of list) lines.push(`- ${n}`);
  };
  skipBlock("cluster member, not the Lead", skips.cluster);
  skipBlock("already replied", skips.replied);
  skipBlock("no Specific Detail", skips.noDetail);
  skipBlock("no template for this channel", skips.noTemplate);
  skipBlock("UNRESOLVED TOKENS", skips.badTokens);
  return lines.join("\n");
}

async function createGoogleDoc(html, title, folderId) {
  const { google } = require("googleapis");
  const { authenticate } = require("@google-cloud/local-auth");

  let auth;
  if (fs.existsSync(DOCS_TOKEN_PATH)) {
    auth = google.auth.fromJSON(JSON.parse(fs.readFileSync(DOCS_TOKEN_PATH, "utf8")));
  } else {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(
        `credentials.json not found at ${CREDENTIALS_PATH}. It is the same OAuth ` +
          `desktop client the Gmail script uses. Or run with --md to skip Google.`
      );
    }
    auth = await authenticate({ scopes: DRIVE_SCOPES, keyfilePath: CREDENTIALS_PATH });
    const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const key = keys.installed || keys.web;
    fs.writeFileSync(
      DOCS_TOKEN_PATH,
      JSON.stringify({
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: auth.credentials.refresh_token,
      })
    );
    console.log("Authorized Drive. Saved token-docs.json (add it to .gitignore).\n");
  }

  const drive = google.drive({ version: "v3", auth });
  // Uploading text/html with a Google-Doc target mimeType makes Drive CONVERT
  // the HTML into a native Google Doc, so headings and monospace blocks survive.
  const res = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: "text/html", body: html },
    fields: "id, webViewLink",
  });
  return res.data;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("Fetching from Airtable...");
  const [events, partners, templates, outreach] = await Promise.all([
    fetchAll(TABLES.events, [
      "Event Name",
      "Slug",
      "Event Start (UTC)",
      "Portfolio Partner",
      "Event Hook",
      "Event Date (Display)",
      "Registration URL",
    ]),
    fetchAll(TABLES.partners, [
      "Name",
      "Contact Method",
      "Contact URL",
      "Instagram URL",
      "Greeting Name",
      "Specific Detail",
      "City",
      "Cluster",
      "Cluster Lead",
      "Best Ask",
      "Secondary Ask",
      "Ownership",
      "Entity Type",
    ]),
    fetchAll(TABLES.templates, [
      "Template Name",
      "Touch Number",
      "Channel",
      "Ask",
      "Body Template",
      "Active",
    ]),
    fetchAll(TABLES.outreach, ["Partner", "Event", "Replied"]),
  ]);

  // --- resolve the cycle -----------------------------------------------------
  let event;
  if (args.eventSlug) {
    event = events.find((e) => e.fields.Slug === args.eventSlug);
    if (!event) {
      console.error(`No Event row with Slug "${args.eventSlug}".`);
      process.exit(1);
    }
  } else {
    event = resolveCurrentEvent(events);
  }
  console.log(`Cycle: ${event.fields["Event Name"]} [${event.fields.Slug}]\n`);

  // --- template lookups ------------------------------------------------------
  const activeEmailTouch1 = templates.filter(
    (t) => t.fields.Channel === "Email" && Number(t.fields["Touch Number"]) === 1 && t.fields.Active === true
  );
  const emailByAsk = new Map();
  for (const t of activeEmailTouch1) {
    const ask = String(t.fields.Ask || "Card").trim();
    if (!emailByAsk.has(ask)) emailByAsk.set(ask, t);
  }
  const emailDefault = emailByAsk.get("Card") || activeEmailTouch1[0];

  const byChannelTouch = (channel, touch) =>
    templates.find(
      (t) =>
        t.fields.Channel === channel &&
        Number(t.fields["Touch Number"]) === touch &&
        t.fields.Active === true
    );

  const resolveTemplate = (p) => {
    const cm = String(p["Contact Method"] || "").trim();
    if (cm === "Contact Form") {
      return {
        template: emailByAsk.get(String(p["Best Ask"] || "Card").trim()) || emailDefault,
        detailOptional: false,
        label: "Contact Form",
      };
    }
    const spec = CHANNEL_RENDER[cm];
    if (!spec) return null;
    return {
      template: byChannelTouch(spec.templateChannel, spec.touch),
      detailOptional: spec.detailOptional,
      label: cm,
    };
  };

  // --- who is in play this cycle --------------------------------------------
  const repliedPartnerIds = new Set();
  for (const o of outreach) {
    if ((o.fields.Event || []).includes(event.id) && o.fields.Replied) {
      for (const pid of o.fields.Partner || []) repliedPartnerIds.add(pid);
    }
  }

  const allowedChannels = resolveChannelFilter(process.argv.slice(2), args.channel);
  if (allowedChannels) console.log(`Channel filter: ${[...allowedChannels].join(", ")}\n`);

  const rendered = {}; // label -> [ {name, city, link, text} ]
  const skips = { cluster: [], replied: [], noDetail: [], noTemplate: [], badTokens: [] };

  for (const partner of partners) {
    const p = partner.fields;
    const name = p.Name || partner.id;

    const cm = String(p["Contact Method"] || "").trim();
    if (cm === "" || cm === "Email") continue; // Email is the Gmail generator's job
    if (allowedChannels && !allowedChannels.has(cm)) continue;

    if (p.Cluster && !p["Cluster Lead"]) {
      skips.cluster.push(`${name} (cluster: ${p.Cluster})`);
      continue;
    }
    if (repliedPartnerIds.has(partner.id)) {
      skips.replied.push(name);
      continue;
    }

    const resolved = resolveTemplate(p);
    if (!resolved || !resolved.template) {
      skips.noTemplate.push(`${name} (${cm || "no method"})`);
      continue;
    }

    const body = resolved.template.fields["Body Template"] || "";
    const needsDetail = /\{Specific Detail\}/.test(body) && !resolved.detailOptional;
    if (needsDetail && !p["Specific Detail"]) {
      skips.noDetail.push(name);
      continue;
    }

    const communityPhrase =
      COMMUNITY_PHRASE_BY_OWNERSHIP[p["Ownership"]] || DEFAULT_COMMUNITY_PHRASE;
    const cityPhrase = p.City || DEFAULT_CITY_PHRASE;
    const isOrganization = String(p["Entity Type"] || "").trim() === "Organization";
    const openerClause = isOrganization
      ? `getting to know the ${communityPhrase} corners of ${cityPhrase}`
      : `researching the ${communityPhrase} businesses around ${cityPhrase}`;

    const secondaryAskLine = SECONDARY_ASK_LINES[p["Secondary Ask"]] || "";
    const spliceSecondary = (str) =>
      String(str || "").split("{Secondary Ask Line}").join(secondaryAskLine);

    const tokens = {
      "Greeting Name": p["Greeting Name"] || "there",
      "Partner Name": p.Name,
      "Specific Detail": p["Specific Detail"] || (resolved.detailOptional ? "" : undefined),
      City: cityPhrase,
      "Event Date": event.fields["Event Date (Display)"],
      "Event Portfolio": event.fields["Portfolio Partner"],
      "Event Hook": event.fields["Event Hook"],
      "Registration URL": event.fields["Registration URL"],
      "Community Phrase": communityPhrase,
      "Opener Clause": openerClause,
    };

    const text = render(spliceSecondary(body), tokens);
    const unresolved = findUnresolvedTokens(text);
    if (unresolved.length) {
      skips.badTokens.push(`${name} — ${unresolved.join(", ")}`);
      continue;
    }

    (rendered[resolved.label] = rendered[resolved.label] || []).push({
      name,
      city: p.City || "",
      link: p["Instagram URL"] || p["Contact URL"] || "",
      text,
    });
  }

  const labels = Object.keys(rendered).sort(
    (a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)
  );
  const total = labels.reduce((n, l) => n + rendered[l].length, 0);
  const skipCount = Object.values(skips).reduce((n, l) => n + l.length, 0);

  console.log(`Rendered ${total} block(s) across ${labels.length} channel(s).`);
  for (const label of labels) console.log(`  ${label}: ${rendered[label].length}`);
  if (skipCount) console.log(`Skipped ${skipCount} (listed at the bottom of the output).`);
  console.log("");

  if (total === 0) {
    console.log("Nothing to render for this cycle. No document created.");
    return;
  }

  // --- emit ------------------------------------------------------------------
  if (args.md) {
    const outPath = path.join(REPO_ROOT, `outreach-copy-${event.fields.Slug}.md`);
    fs.writeFileSync(outPath, buildMarkdown(event, rendered, skips), "utf8");
    console.log(`Wrote ${outPath}`);
    console.log("Open it, copy each block into its channel by hand.");
    return;
  }

  const html = buildHtml(event, rendered, skips);
  const title = `Non-email outreach — ${event.fields["Event Name"]} (${event.fields["Event Date (Display)"]})`;
  try {
    const doc = await createGoogleDoc(html, title, args.folder);
    console.log(`Created Google Doc: ${doc.webViewLink || doc.id}`);
    console.log("Open it, copy each block into its channel by hand.");
  } catch (err) {
    console.error(`\nGoogle Doc creation failed: ${err.message}`);
    console.error("Re-run with --md to write a local Markdown file instead.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
