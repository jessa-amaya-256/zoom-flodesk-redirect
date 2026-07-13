/**
 * /api/admin/sync-events
 *
 * POST-only endpoint that replaces the full "EVENTS" object in Vercel
 * Edge Config — the join/reserve routes' primary source of per-event
 * config (flodeskField, segmentId, fallbackUrl).
 *
 * Intended caller: a Zapier Zap watching the "Redirect — Events" table
 * in Airtable (trigger: New or Updated Record), which then lists every
 * row in that table and POSTs the whole set here on every change — see
 * README-events-sync.md for the exact Zap steps. This endpoint always
 * does a full replace, not a per-event upsert, so a deleted or renamed
 * Airtable row is reflected correctly too, not just additions.
 *
 * Auth: shared-secret header, checked against process.env.ADMIN_SECRET
 *   x-admin-secret: <secret>
 *
 * Body:
 *   {
 *     "events": [
 *       {
 *         "slug": "celebrity-alaska",
 *         "flodeskField": "zoomLinkCelebrityAlaska",
 *         "segmentId": "6a46d7baf305fe60db28f779",
 *         "fallbackUrl": "https://www.amaya-travel.com"
 *       },
 *       ...
 *     ]
 *   }
 *
 * segmentId is optional — /api/join doesn't need it, only /api/reserve
 * does. If it's blank for an event, that event's one-click reserve
 * links simply fall back to config.fallbackUrl (same behavior as
 * before this change).
 *
 * Requires the same VERCEL_API_TOKEN / EDGE_CONFIG_ID env vars already
 * used by /api/admin/update-current-event.
 */

const VERCEL_API_BASE = 'https://api.vercel.com';
const EDGE_CONFIG_KEY = 'EVENTS';
const REQUIRED_FIELDS = ['slug', 'flodeskField', 'fallbackUrl'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed. Use POST.');
    return;
  }

  const providedSecret = req.headers['x-admin-secret'];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    res.status(401).send('Unauthorized.');
    return;
  }

  let { events } = req.body || {};

  // Zapier's Webhooks by Zapier (JSON payload type) sends whatever value
  // is mapped into a field as-is — if the upstream Code by Zapier step
  // already JSON.stringify()'d the array (which it does, since passing
  // real arrays through Zapier's own field mapping gets silently mangled
  // into a lossy debug-string format), events arrives here as a STRING
  // containing JSON text, not a real array. Parse it if so, rather than
  // fight Zapier's payload builder further.
  if (typeof events === 'string') {
    try {
      events = JSON.parse(events);
    } catch (err) {
      res.status(400).send('Field "events" was a string but not valid JSON.');
      return;
    }
  }

  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).send('Missing or empty required field: events (array).');
    return;
  }

  const eventsMap = {};
  for (const [index, ev] of events.entries()) {
    const missing = REQUIRED_FIELDS.filter((field) => !ev || !ev[field]);
    if (missing.length > 0) {
      res
        .status(400)
        .send(`events[${index}] is missing required field(s): ${missing.join(', ')}.`);
      return;
    }
    eventsMap[ev.slug] = {
      flodeskField: ev.flodeskField,
      segmentId: ev.segmentId || null,
      fallbackUrl: ev.fallbackUrl,
    };
  }

  const vercelToken = process.env.VERCEL_API_TOKEN;
  const edgeConfigId = process.env.EDGE_CONFIG_ID;

  if (!vercelToken || !edgeConfigId) {
    console.error('VERCEL_API_TOKEN or EDGE_CONFIG_ID is not set.');
    res.status(500).send('Server misconfiguration.');
    return;
  }

  try {
    const response = await fetch(
      `${VERCEL_API_BASE}/v1/edge-config/${edgeConfigId}/items`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: [
            {
              operation: 'upsert',
              key: EDGE_CONFIG_KEY,
              value: eventsMap,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Edge Config update failed: ${response.status} ${errorBody}`);
      res.status(502).send('Failed to update Edge Config.');
      return;
    }

    res.status(200).json({
      ok: true,
      key: EDGE_CONFIG_KEY,
      eventCount: Object.keys(eventsMap).length,
      slugs: Object.keys(eventsMap),
    });
  } catch (err) {
    console.error('Edge Config update error:', err);
    res.status(500).send('Internal error updating Edge Config.');
  }
};
