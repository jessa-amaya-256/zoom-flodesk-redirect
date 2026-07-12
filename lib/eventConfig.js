/**
 * lib/eventConfig.js
 *
 * Resolves per-event redirect config (flodeskField, segmentId,
 * fallbackUrl) for a given event slug.
 *
 * Primary source: Vercel Edge Config, key "EVENTS" — a JSON object
 * keyed by slug, kept in sync with the "Redirect — Events" table in
 * Airtable via a Zap that POSTs to /api/admin/sync-events on every
 * add/edit (see README-events-sync.md for the exact Zap steps).
 *
 * Fallback source: lib/events.js's static EVENT_CONFIG — used only if
 * Edge Config is unreachable, or the EVENTS key hasn't been synced
 * yet, so the service degrades gracefully instead of going fully down.
 * That static file is a safety net now, not the place to add new
 * events going forward — add those in Airtable instead.
 */

const { get } = require('@vercel/edge-config');
const { EVENT_CONFIG: STATIC_FALLBACK } = require('./events');

async function getEventConfig(slug) {
  try {
    const events = await get('EVENTS');
    if (events && typeof events === 'object') {
      return events[slug]; // undefined here just means a genuinely unknown slug
    }
    console.error('EVENTS key not found in Edge Config — using static fallback.');
  } catch (err) {
    console.error('Edge Config read error for EVENTS, using static fallback:', err);
  }

  return STATIC_FALLBACK[slug];
}

module.exports = { getEventConfig };
