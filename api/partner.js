/**
 * /api/partner
 *
 * Public redirect endpoint for B2B partner referral links.
 *
 * Called via a clean URL per partner, e.g.:
 *   https://join.clarkco.travel/partner/fairhaven-gallery
 *
 * That clean URL is rewritten (see vercel.json) to:
 *   /api/partner?slug=fairhaven-gallery
 *
 * Reads the single "current promoted event" URL out of Vercel Edge
 * Config (key: CURRENT_EVENT_RSVP_URL) and 302-redirects there with
 * ?utm_source={slug} and ?utm_medium={medium} appended. The partner
 * roster itself lives in Airtable (see scripts/generate-qr-codes.js) —
 * this route doesn't validate the slug against anything; any slug is
 * passed straight through as the UTM value, same as the brief specifies.
 *
 * ---------------------------------------------------------------------
 * WHY THE MEDIUM PARAMETER EXISTS
 *
 * A QR code is nothing but an encoding of a URL. The letterpress card
 * and a hyperlink in a partner's newsletter are THE SAME INSTRUMENT
 * wearing different clothes — so the same /partner/{slug} link serves
 * both, and always did.
 *
 * What it could NOT do was tell them apart. Every referral collapsed
 * into a single utm_source, so the data could say WHICH PARTNER worked
 * and never WHICH ASK worked. That matters now, because the roster has
 * six asks (card, newsletter, social post, referral deal, co-hosted
 * event, paid placement) and money is about to be spent on the ones
 * that are not cards.
 *
 * So: ?m= sets utm_medium. Defaults to "card", because the printed QR
 * is the only medium that CANNOT carry a query string a human typed —
 * whatever is encoded at print time is what ships, forever. Everything
 * else is a hyperlink someone pastes, and a hyperlink can carry
 * anything.
 *
 * Usage:
 *   /partner/pony                 -> utm_medium=card       (the QR default)
 *   /partner/pony?m=newsletter    -> utm_medium=newsletter
 *   /partner/pony?m=eblast        -> utm_medium=eblast     (GSBA, paid)
 *   /partner/pony?m=social        -> utm_medium=social
 *   /partner/pony?m=bio           -> utm_medium=bio        (link-in-bio)
 *   /partner/pony?m=print         -> utm_medium=print      (Betty Pages etc.)
 *
 * KNOWN LIMITATION, AND IT IS NOT FIXABLE HERE: an Instagram feed
 * caption is not clickable. There is no link to tag. A Story link
 * sticker or a link-in-bio can carry ?m=, a caption cannot. The single
 * ask most likely to be made of a high-follower partner is the one ask
 * whose result cannot be measured. That is Instagram's product decision,
 * not a gap in this file.
 * ---------------------------------------------------------------------
 */

const { get } = require('@vercel/edge-config');

const FALLBACK_URL = 'https://amaya-travel.com/upcoming-cruise-nights';

// The medium a bare /partner/{slug} is assumed to have come from.
// See the note above: the printed card is the only medium that cannot
// append its own parameter after the fact, so it gets the default.
const DEFAULT_MEDIUM = 'card';

/**
 * Normalize the medium into something that will not poison the
 * analytics with near-duplicates ("Newsletter", "news letter",
 * "NEWSLETTER  " all becoming separate rows in a report).
 *
 * Deliberately NOT an allowlist. The slug isn't validated either, and
 * an allowlist here would silently drop a medium the moment a new ask
 * type is invented — failing closed on the exact data we are trying to
 * collect. Garbage in the report is recoverable. A silently discarded
 * conversion is not.
 */
function normalizeMedium(raw) {
  if (typeof raw !== 'string') return DEFAULT_MEDIUM;

  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);

  return cleaned || DEFAULT_MEDIUM;
}

module.exports = async (req, res) => {
  const { slug, m } = req.query;

  if (!slug) {
    res.status(400).send('Missing required parameter: slug.');
    return;
  }

  const medium = normalizeMedium(m);

  let targetUrl = FALLBACK_URL;

  try {
    const currentEventUrl = await get('CURRENT_EVENT_RSVP_URL');
    if (currentEventUrl) {
      targetUrl = currentEventUrl;
    } else {
      console.error(
        'CURRENT_EVENT_RSVP_URL is not set in Edge Config — using fallback.'
      );
    }
  } catch (err) {
    console.error('Edge Config read error:', err);
    // targetUrl stays at FALLBACK_URL
  }

  let redirectUrl;
  try {
    redirectUrl = new URL(targetUrl);
    redirectUrl.searchParams.set('utm_source', slug);
    redirectUrl.searchParams.set('utm_medium', medium);
  } catch (err) {
    console.error(`Invalid target URL "${targetUrl}", falling back.`, err);
    redirectUrl = new URL(FALLBACK_URL);
    redirectUrl.searchParams.set('utm_source', slug);
    redirectUrl.searchParams.set('utm_medium', medium);
  }

  res.writeHead(302, { Location: redirectUrl.toString() });
  res.end();
};
