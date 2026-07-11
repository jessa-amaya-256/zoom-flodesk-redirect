/**
 * /api/debug
 *
 * TEMPORARY diagnostic tool — shows the raw Flodesk API response for a
 * given email, so you can see exactly what custom field keys exist and
 * confirm the API key is working.
 *
 * Protected by a secret so random visitors can't see subscriber data:
 *   https://join.jessicaclark.travel/api/debug?email=someone@example.com&secret=YOUR_SECRET
 *
 * Delete this file once debugging is done — it's not meant to stay in
 * production long-term.
 */

const FLODESK_API_BASE = 'https://api.flodesk.com/v1';

module.exports = async (req, res) => {
  const { email, secret } = req.query;

  const expectedSecret = process.env.DEBUG_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    res.status(403).json({ error: 'Missing or incorrect secret.' });
    return;
  }

  if (!email) {
    res.status(400).json({ error: 'Missing email parameter.' });
    return;
  }

  const apiKey = process.env.FLODESK_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'FLODESK_API_KEY is not set in this deployment.',
    });
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
          'User-Agent': 'JessicaClarkTravel-Debug (jessicaclark.travel)',
        },
      }
    );

    const body = await response.json().catch(() => null);

    res.status(200).json({
      flodesk_http_status: response.status,
      flodesk_response: body,
    });
  } catch (err) {
    res.status(500).json({ error: 'Request failed', details: String(err) });
  }
};
