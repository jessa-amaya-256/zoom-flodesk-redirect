/**
 * /api/reserve
 *
 * One-click "Reserve My Spot" endpoint for warm leads already in your
 * Flodesk audience (e.g. the "Secure your next invitation" CTA in a
 * prior event's final nurture email).
 *
 * This does NOT call the Zoom API directly. Its only job is to add the
 * subscriber to the target event's Flodesk segment. That segment-add is
 * exactly what the target event's own registration Zap already listens
 * for (Flodesk "Subscriber Added to Segment" → Zoom "Create Meeting
 * Registrant" → Flodesk "Create/Update Subscriber") — so Zoom
 * registration and the confirmation email both happen automatically
 * through the pipeline you've already built for that event.
 *
 * IMPORTANT: the target event's full pipeline (segment, custom field,
 * registration Zap, confirmation workflow) must already be live before
 * this link goes out in an email — otherwise the segment-add has
 * nothing listening for it.
 *
 * Called via:
 *   https://join.jessicaclark.travel/reserve?event=virgin-voyages&adt_ei={{ subscriber.email }}
 */

const { EVENT_CONFIG } = require('../lib/events');

const FLODESK_API_BASE = 'https://api.flodesk.com/v1';

// Simple, brand-neutral confirmation page shown on success — no separate
// landing page needs to exist on your site for this to work.
function renderConfirmation() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>You're confirmed</title>
  <style>
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      background: #F4F4F0;
      color: #1C1E1D;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
      padding: 24px;
    }
    .card { max-width: 420px; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 16px; line-height: 1.5; color: #4C4F4A; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're confirmed.</h1>
    <p>Your spot is reserved. Check your inbox shortly for your private access details.</p>
  </div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  const { event } = req.query;
  const email = req.query.adt_ei || req.query.email;

  if (!event || !email) {
    res.status(400).send('Missing required parameters: event and email.');
    return;
  }

  const config = EVENT_CONFIG[event];
  if (!config) {
    res.status(404).send(`Unknown event: ${event}`);
    return;
  }

  if (!config.segmentId) {
    console.error(`No segmentId configured for event: ${event}`);
    res.writeHead(302, { Location: config.fallbackUrl });
    res.end();
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
      `${FLODESK_API_BASE}/subscribers/${encodeURIComponent(email).replace(/%40/g, '@')}/segments`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          'User-Agent': 'JessicaClarkTravel-Reserve (jessicaclark.travel)',
        },
        body: JSON.stringify({ segment_ids: [config.segmentId] }),
      }
    );

    if (!response.ok) {
      console.error(
        `Failed to add ${email} to segment for ${event}: ${response.status}`
      );
      res.writeHead(302, { Location: config.fallbackUrl });
      res.end();
      return;
    }

    // Success — show a warm confirmation. The actual Zoom registration
    // and confirmation email happen moments later, automatically,
    // driven by the target event's own existing Zap.
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(renderConfirmation());
  } catch (err) {
    console.error('Reserve error:', err);
    res.writeHead(302, { Location: config.fallbackUrl });
    res.end();
  }
};
