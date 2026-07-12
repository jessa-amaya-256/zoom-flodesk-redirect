/**
 * /api/partner
 *
 * Public redirect endpoint for B2B partner letterpress-card QR codes.
 *
 * Called via a clean URL per partner, e.g.:
 *   https://join.jessicaclark.travel/partner/fairhaven-gallery
 *
 * That clean URL is rewritten (see vercel.json) to:
 *   /api/partner?slug=fairhaven-gallery
 *
 * Reads the single "current promoted event" URL out of Vercel Edge
 * Config (key: CURRENT_EVENT_RSVP_URL) and 302-redirects there with
 * ?utm_source={slug} appended. The partner roster itself lives in
 * Airtable (see scripts/generate-qr-codes.js) — this route doesn't
 * validate the slug against anything; any slug is passed straight
 * through as the UTM value, same as the brief specifies.
 */

const { get } = require('@vercel/edge-config');

const FALLBACK_URL = 'https://amaya-travel.com/upcoming-cruise-nights';

module.exports = async (req, res) => {
  const { slug } = req.query;

  if (!slug) {
    res.status(400).send('Missing required parameter: slug.');
    return;
  }

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
  } catch (err) {
    console.error(`Invalid target URL "${targetUrl}", falling back.`, err);
    redirectUrl = new URL(FALLBACK_URL);
    redirectUrl.searchParams.set('utm_source', slug);
  }

  res.writeHead(302, { Location: redirectUrl.toString() });
  res.end();
};
