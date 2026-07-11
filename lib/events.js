/**
 * lib/events.js
 *
 * Single source of truth for every event in the series. Both the join
 * redirect (api/join.js) and the one-click reservation endpoint
 * (api/reserve.js) read from this same object, so adding a new event
 * only ever requires editing ONE place.
 */

const EVENT_CONFIG = {
  'celebrity-alaska': {
    flodeskField: 'zoomLinkCelebrityAlaska',
    segmentId: '6a46d7baf305fe60db28f779', // "CC 9/22 (Alaska) RSVP"
    fallbackUrl: 'https://www.amaya-travel.com',
  },
  'virgin-voyages': {
    flodeskField: 'zoomLinkVirginVoyages',
    segmentId: '6a4e8f6a854639275297f766', // "VV 10/22 RSVP"
    fallbackUrl: 'https://www.amaya-travel.com',
  },
};

module.exports = { EVENT_CONFIG };
