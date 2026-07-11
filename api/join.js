/**
 * /api/join
 *
 * Looks up a subscriber's personalized Zoom join_url (stored as a Flodesk
 * custom field) and 302-redirects them straight to Zoom.
 *
 * Called via a clean URL per event, e.g.:
 *   https://join.jessicaclark.travel/celebrity-alaska?email=jess@example.com
 *
 * That clean URL is rewritten (see vercel.json) to:
 *   /api/join?event=celebrity-alaska&email=jess@example.com
 *
 * In your Flodesk email, the button/link URL should be:
 *   https://join.jessicaclark.travel/celebrity-alaska?email=@Email
 * (Flodesk supports inserting the subscriber's email into a URL as a
 * query param — this part of the URL is static text, only the value of
 * the @Email merge tag itself is dynamic per-subscriber.)
 */

// Map each event slug to the Flodesk custom field that holds its Zoom
// join_url, plus a fallback URL to send people to if something goes wrong
// (field missing, subscriber not found, API error, etc).
//
// To add a new event: add a new entry here and redeploy.
const EVENT_CONFIG = {
  'celebrity-alaska': {
    flodeskField: 'zoomLinkCelebrityAlaska',
    fallbackUrl: 'https://www.amaya-travel.com',
  },
  // 'next-event-slug': {
  //   flodeskField: 'zoom_link_next_event',
  //   fallbackUrl: 'https://www.jessicaclark.travel/next-event',
  // },
};

const FLODESK_API_BASE = 'https://api.flodesk.com/v1';

module.exports = async (req, res) => {
  const { event } = req.query;
  // Flodesk's `@Email` merge tag only renders inside plain Text blocks —
  // it does NOT render inside Button/Link href fields. Flodesk instead
  // provides a separate link-level snippet, `{{ subscriber.email }}`,
  // meant to be pasted directly into a URL (their documented use case is
  // `?adt_ei={{ subscriber.email }}`). We accept that param name here,
  // while still falling back to `email` in case this is hit manually
  // (e.g. during testing) or from a non-Flodesk source.
  const email = req.query.adt_ei || req.query.email;

  // --- Basic input validation ---
  if (!event || !email) {
    res.status(400).send('Missing required parameters: event and email.');
    return;
  }

  const config = EVENT_CONFIG[event];
  if (!config) {
    res.status(404).send(`Unknown event: ${event}`);
    return;
  }

  const apiKey = process.env.FLODESK_API_KEY;
  if (!apiKey) {
    // Server misconfiguration — don't leak details to the visitor, but
    // send them somewhere useful rather than an error page.
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

    // Success — send them straight to their personal Zoom join link.
    res.writeHead(302, { Location: joinUrl });
    res.end();
  } catch (err) {
    console.error('Redirect lookup error:', err);
    res.writeHead(302, { Location: config.fallbackUrl });
    res.end();
  }
};
