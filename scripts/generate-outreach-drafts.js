#!/usr/bin/env node
/**
 * scripts/generate-outreach-drafts.js
 *
 * LOCAL-ONLY. Not deployed to Vercel — run this from your own machine.
 *
 * Renders partner outreach emails for one event cycle and creates them
 * as DRAFTS in Gmail. It never sends. Every draft is reviewed by a human
 * before it leaves the outbox — that is the whole point of the design.
 *
 * The join:
 *   Outreach (one row per Partner x Event)
 *     -> Partner   (stable facts: Greeting Name, Specific Detail, Email)
 *     -> Event     (Portfolio Partner, Event Hook, Event Date (Display))
 *     + Templates  (matched on Channel = Email, Touch Number, Active)
 *
 * Usage:
 *   node scripts/generate-outreach-drafts.js --event=celebrity-alaska --dry-run
 *   node scripts/generate-outreach-drafts.js --event=celebrity-alaska --touch=1
 *   node scripts/generate-outreach-drafts.js --event=celebrity-alaska --touch=2 --overwrite
 *
 * Flags:
 *   --event=<slug>      REQUIRED. Matches Events.Slug (e.g. celebrity-alaska).
 *   --touch=<n>         Which touch to render. Default 1.
 *   --dry-run           Render and validate, print to stdout, write nothing
 *                       to Gmail and nothing back to Airtable. Run this first.
 *                       Always run this first.
 *   --overwrite         Allow overwriting a populated Draft Subject / Draft Body
 *                       on the Outreach row. Off by default: populated fields are
 *                       never silently clobbered.
 *   --limit=<n>         Stop after n drafts. Useful for a cautious first run.
 *
 * Required env vars:
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *   REGISTRATION_URL        The {Registration URL} token value for this cycle.
 *   GMAIL_CLIENT_ID         }
 *   GMAIL_CLIENT_SECRET     } OAuth desktop-app credentials + a refresh token
 *   GMAIL_REFRESH_TOKEN     } with scope https://www.googleapis.com/auth/gmail.compose
 *   GMAIL_FROM              The From: address (e.g. "Jessica Clark <jess@...>")
 *
 * Not required for --dry-run: the four GMAIL_* vars. You can validate every
 * render before you ever wire up Gmail auth.
 */

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

// Table IDs, not names. Names are mutable; there is already a
// "Partners (legacy)" archive one rename away from being read by mistake.
const TABLES = {
  events: 'tbl8I56RgDqgXFpQ5',
  partners: 'tblFlH8ssP07XdrhZ',
  outreach: 'tblstWlG7RC3R4fRA',
  templates: 'tblwww889pqm5NAGE',
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const get = (name) => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`));
    return flag ? flag.split('=').slice(1).join('=') : undefined;
  };
  const has = (name) => argv.includes(`--${name}`);

  const eventSlug = get('event');
  if (!eventSlug) {
    console.error('Missing required flag: --event=<slug> (e.g. --event=celebrity-alaska)');
    process.exit(1);
  }

  const limitRaw = get('limit');

  return {
    eventSlug,
    touch: Number(get('touch') || 1),
    dryRun: has('dry-run'),
    overwrite: has('overwrite'),
    limit: limitRaw ? Number(limitRaw) : Infinity,
  };
}

// ---------------------------------------------------------------------------
// airtable
// ---------------------------------------------------------------------------

async function airtableList(apiKey, baseId, tableId, fields) {
  const rows = [];
  let offset;

  do {
    const url = new URL(`${AIRTABLE_API_BASE}/${baseId}/${tableId}`);
    for (const field of fields) url.searchParams.append('fields[]', field);
    if (offset) url.searchParams.set('offset', offset);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Airtable list failed for ${tableId}: ${response.status} ${body}`);
    }

    const data = await response.json();
    rows.push(...data.records);
    offset = data.offset;
  } while (offset);

  return rows;
}

async function airtablePatch(apiKey, baseId, tableId, recordId, fields) {
  const response = await fetch(
    `${AIRTABLE_API_BASE}/${baseId}/${tableId}/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable update failed for ${recordId}: ${response.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// gmail — plain REST, no SDK, consistent with the rest of this repo
// ---------------------------------------------------------------------------

async function getGmailAccessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gmail token refresh failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

// RFC 2047 encode the Subject so an em dash or a curly apostrophe in a
// partner's name doesn't arrive as mojibake.
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, to, subject, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ];
  return lines.join('\r\n');
}

function base64Url(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createGmailDraft(accessToken, mime) {
  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: { raw: base64Url(mime) } }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gmail draft creation failed: ${response.status} ${body}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render(template, tokens) {
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    const value = tokens[key.trim()];
    return value === undefined || value === null || value === '' ? match : value;
  });
}

/**
 * The assert that matters. If any {Token} survives rendering, the email is
 * broken — and a body reading "Hi there, ... {Event Hook} ..." landing in a
 * partner's inbox costs the relationship, not just the send. Fail loudly and
 * skip the row rather than draft something unsendable.
 */
function findUnresolvedTokens(...rendered) {
  const found = new Set();
  for (const text of rendered) {
    for (const match of text.matchAll(/\{[^}]+\}/g)) found.add(match[0]);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const registrationUrl = process.env.REGISTRATION_URL;

  if (!apiKey || !baseId) {
    console.error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID in environment.');
    process.exit(1);
  }
  if (!registrationUrl) {
    console.error('Missing REGISTRATION_URL in environment — that is the {Registration URL} token.');
    process.exit(1);
  }
  if (!args.dryRun) {
    const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_FROM']
      .filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`Missing Gmail env var(s): ${missing.join(', ')}. Or use --dry-run.`);
      process.exit(1);
    }
  }

  console.log(`Event:     ${args.eventSlug}`);
  console.log(`Touch:     ${args.touch}`);
  console.log(`Mode:      ${args.dryRun ? 'DRY RUN — nothing will be written' : 'LIVE — Gmail drafts will be created'}`);
  console.log('');

  // --- fetch -----------------------------------------------------------------

  const [events, partners, templates, outreach] = await Promise.all([
    airtableList(apiKey, baseId, TABLES.events, [
      'Event Name', 'Slug', 'Portfolio Partner', 'Event Hook', 'Event Date (Display)',
    ]),
    airtableList(apiKey, baseId, TABLES.partners, [
      'Name', 'Email', 'Contact Method', 'Greeting Name', 'Specific Detail',
    ]),
    airtableList(apiKey, baseId, TABLES.templates, [
      'Template Name', 'Touch Number', 'Channel', 'Subject Template', 'Body Template', 'Active',
    ]),
    airtableList(apiKey, baseId, TABLES.outreach, [
      'Outreach', 'Partner', 'Event', 'Draft Subject', 'Draft Body',
    ]),
  ]);

  // --- resolve event ---------------------------------------------------------

  const event = events.find((e) => e.fields.Slug === args.eventSlug);
  if (!event) {
    console.error(`No Event row with Slug "${args.eventSlug}". Known slugs: ${events.map((e) => e.fields.Slug).filter(Boolean).join(', ')}`);
    process.exit(1);
  }

  const missingEventFields = ['Portfolio Partner', 'Event Hook', 'Event Date (Display)']
    .filter((f) => !event.fields[f]);
  if (missingEventFields.length > 0) {
    console.error(`Event "${args.eventSlug}" is missing: ${missingEventFields.join(', ')}. Fill these in Airtable before rendering.`);
    process.exit(1);
  }

  // --- resolve template ------------------------------------------------------

  const template = templates.find(
    (t) =>
      t.fields.Channel === 'Email' &&
      Number(t.fields['Touch Number']) === args.touch &&
      t.fields.Active === true
  );

  if (!template) {
    console.error(`No ACTIVE Email template with Touch Number ${args.touch}. Matching on all three of Channel/Touch Number/Active is deliberate — without the Channel filter this would happily grab the Phone or Instagram script.`);
    process.exit(1);
  }
  console.log(`Template:  ${template.fields['Template Name']}\n`);

  const partnersById = new Map(partners.map((p) => [p.id, p]));

  // --- render ----------------------------------------------------------------

  const rows = outreach.filter((o) => (o.fields.Event || []).includes(event.id));

  const skips = {
    noPartnerLink: 0,
    noSpecificDetail: 0,
    notEmailChannel: 0,
    noEmailAddress: 0,
    alreadyDrafted: 0,
    unresolvedTokens: 0,
  };
  const drafted = [];

  let accessToken;
  if (!args.dryRun) accessToken = await getGmailAccessToken();

  for (const row of rows) {
    if (drafted.length >= args.limit) break;

    const partnerId = (row.fields.Partner || [])[0];
    const partner = partnerId ? partnersById.get(partnerId) : undefined;

    if (!partner) {
      console.error(`  SKIP  ${row.fields.Outreach || row.id} — no linked Partner.`);
      skips.noPartnerLink += 1;
      continue;
    }

    const p = partner.fields;

    // GATE 1 — the quality gate. A blank Specific Detail means nobody has
    // found one true, sourced thing to say about this business. The row is
    // skipped rather than padded with a generic sentence. The blank is a
    // feature; do not "fix" it by defaulting.
    if (!p['Specific Detail']) {
      skips.noSpecificDetail += 1;
      continue;
    }

    // GATE 2 — channel. Roughly 20 of the 52 partners are DM/phone/in-person
    // only. Without this check the join would cheerfully render an email for
    // a business that has no email.
    if (p['Contact Method'] !== 'Email') {
      skips.notEmailChannel += 1;
      continue;
    }

    if (!p.Email) {
      console.error(`  SKIP  ${p.Name} — Contact Method is "Email" but the Email field is empty. Fix in Airtable.`);
      skips.noEmailAddress += 1;
      continue;
    }

    // Never clobber a populated draft field unless explicitly told to.
    if (!args.overwrite && (row.fields['Draft Subject'] || row.fields['Draft Body'])) {
      skips.alreadyDrafted += 1;
      continue;
    }

    const tokens = {
      'Greeting Name': p['Greeting Name'] || 'there',
      'Partner Name': p.Name,
      'Specific Detail': p['Specific Detail'],
      'Event Date': event.fields['Event Date (Display)'],
      'Event Portfolio': event.fields['Portfolio Partner'],
      'Event Hook': event.fields['Event Hook'],
      'Registration URL': registrationUrl,
    };

    const subject = render(template.fields['Subject Template'] || '', tokens);
    const body = render(template.fields['Body Template'] || '', tokens);

    const unresolved = findUnresolvedTokens(subject, body);
    if (unresolved.length > 0) {
      console.error(`  SKIP  ${p.Name} — unresolved token(s): ${unresolved.join(', ')}`);
      skips.unresolvedTokens += 1;
      continue;
    }

    if (args.dryRun) {
      console.log('─'.repeat(72));
      console.log(`TO:      ${p.Name} <${p.Email}>`);
      console.log(`SUBJECT: ${subject}`);
      console.log('');
      console.log(body);
      console.log('');
    } else {
      const mime = buildMime({
        from: process.env.GMAIL_FROM,
        to: p.Email,
        subject,
        body,
      });
      await createGmailDraft(accessToken, mime);
      await airtablePatch(apiKey, baseId, TABLES.outreach, row.id, {
        'Draft Subject': subject,
        'Draft Body': body,
      });
      console.log(`  DRAFT ${p.Name} <${p.Email}>`);
    }

    drafted.push(p.Name);
  }

  // --- summary ---------------------------------------------------------------

  console.log('\n' + '='.repeat(72));
  console.log(`Outreach rows for this event:  ${rows.length}`);
  console.log(`Drafted:                       ${drafted.length}`);
  console.log('Skipped:');
  console.log(`  no Specific Detail           ${skips.noSpecificDetail}   <- the quality gate, working`);
  console.log(`  not an Email channel         ${skips.notEmailChannel}   <- route these to Phone / DM scripts`);
  console.log(`  Email channel, no address    ${skips.noEmailAddress}`);
  console.log(`  already drafted              ${skips.alreadyDrafted}`);
  console.log(`  no linked Partner            ${skips.noPartnerLink}`);
  console.log(`  unresolved tokens            ${skips.unresolvedTokens}`);

  if (args.dryRun) {
    console.log('\nDry run — no Gmail drafts created, no Airtable fields written.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
