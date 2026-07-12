/**
 * /api/join
 *
 * Looks up a subscriber's personalized Zoom join_url (stored as a Flodesk
 * custom field) and 302-redirects them straight to Zoom.
 *
 * Called via a clean URL per event, e.g.:
 *   https://join.jessicaclark.travel/celebrity-alaska?adt_ei=jess@example.com
 *
 * That clean URL is rewritten (see vercel.json) to:
 *   /api/join?event=celebrity-alaska&adt_ei=jess@example.com
 *
 * In your Flodesk email, the button/link URL should be:
 *   https://join.jessicaclark.travel/celebrity-alaska?adt_ei={{ subscriber.email }}
 *   (`{{ subscriber.email }}` is Flodesk's link-level email snippet — it
 *   works inside Button/Link URL fields, unlike the `@Email` merge tag,
 *   which only renders inside plain Text block content.)
 *
 * Event config (flodeskField / fallbackUrl) now comes from
 * lib/eventConfig.js — Edge Config first, static lib/events.js as a
 * fallback. See that file and README-events-sync.md for how new
 * events (Airtable → Zap → Edge Config) flow in.
 */

const { getEventConfig } = require('../lib/eventConfig');

const FLODESK_API_BASE = 'https://api.flodesk.com/v1';

module.exports = async (req, res) => {
  const { event } = req.query;
  const email = req.query.adt_ei || req.query.email;

  if (!event || !email) {
    res.status(400).send('Missing required parameters: event and email.');
    return;
  }

  const config = await getEventConfig(event);
  if (!config) {
    res.status(404).send(`Unknown event: ${event}`);
    return;
  }

  const apiKey = process.env.FLODESK_API_KEY;
  if (!apiKey) {
    console.error('FLODESK_API_KEY is not set.');
    res.writeHead(302, { Location: config.fallbackUrl });
    res.end();
    return;
  }

  try {
    const authHeader =
      'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

    const response = await fetch(
      `${FLODESK_API_BASE}/subscribers/${encodeURIComponent(email).replace(/%40/g, '@')}`,
      {
        headers: {
          Authorization: authHeader,
          'User-Agent': 'JessicaClarkTravel-Redirect (jessicaclark.travel)',
        },
      }
    );

    if (!response.ok) {
      console.error(
        `Flodesk lookup failed for ${email}: ${response.status}`
      );
      res.writeHead(302, { Location: config.fallbackUrl });
      res.end();
      return;
    }

    const subscriber = await response.json();
    const joinUrl = subscriber?.custom_fields?.[config.flodeskField];

    if (!joinUrl) {
      console.error(
        `No ${config.flodeskField} value found for ${email}.`
      );
      res.writeHead(302, { Location: config.fallbackUrl });
      res.end();
      return;
    }

    res.writeHead(302, { Location: joinUrl });
    res.end();
  } catch (err) {
    console.error('Redirect lookup error:', err);
    res.writeHead(302, { Location: config.fallbackUrl });
    res.end();
  }
};
