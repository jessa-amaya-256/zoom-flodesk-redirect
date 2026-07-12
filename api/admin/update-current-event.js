/**
 * /api/admin/update-current-event
 *
 * POST-only endpoint that updates the CURRENT_EVENT_RSVP_URL key in
 * Vercel Edge Config, which drives every /api/partner redirect.
 * Intended to be called by a Zapier webhook step ~1 hour after each
 * event ends, pivoting all partner QR codes to the next event's RSVP
 * page without reprinting a single card.
 *
 * Auth: shared-secret header, checked against process.env.ADMIN_SECRET.
 *   x-admin-secret: <secret>
 *
 * Body: { "url": "https://..." }
 *
 * Requires two env vars beyond ADMIN_SECRET:
 *   VERCEL_API_TOKEN — a Vercel personal access token with write
 *                       access to this project's Edge Config store
 *   EDGE_CONFIG_ID    — the Edge Config store's ID (starts with
 *                       "ecfg_"), found in Vercel → Storage → Edge Config
 *                       → (your store) → Settings
 */

const VERCEL_API_BASE = 'https://api.vercel.com';
const EDGE_CONFIG_KEY = 'CURRENT_EVENT_RSVP_URL';

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

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    res.status(400).send('Missing required field: url (string).');
    return;
  }

  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch (err) {
    res.status(400).send('Field "url" must be a valid absolute URL.');
    return;
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
              value: url,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `Edge Config update failed: ${response.status} ${errorBody}`
      );
      res.status(502).send('Failed to update Edge Config.');
      return;
    }

    res.status(200).json({ ok: true, key: EDGE_CONFIG_KEY, updated: url });
  } catch (err) {
    console.error('Edge Config update error:', err);
    res.status(500).send('Internal error updating Edge Config.');
  }
};
