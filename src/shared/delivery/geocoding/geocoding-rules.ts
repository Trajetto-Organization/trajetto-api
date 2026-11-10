/**
 * The geocoding queue's numbers (plan of 02/11/2026, E1), apart from the
 * SQL so the twin, the route read (address-lookup-state.ts) and the tests
 * read the same ones without a database.
 */

/**
 * Claims stop after this many: an address the provider failed on eight
 * times, over about twenty hours, is left for a person (the route map's
 * "Fixar no mapa"). It was five, with a linear back-off: an outage of two
 * and a half hours exhausted every open delivery.
 */
const GEOCODING_MAX_ATTEMPTS = 8;

/**
 * The back-off after a failure, doubling from 15 min per attempt already
 * made and capped at 6 h: 15, 30, 60, 120, 240, 360, 360. Also the lease of
 * a claim whose replica died.
 */
const GEOCODING_BACKOFF_MINUTES = 15;
const GEOCODING_BACKOFF_CAP_MINUTES = 360;

/** The minutes a delivery with `attempts` made waits before the next claim. */
function geocodingBackoffMinutes(attempts: number): number {
  return Math.min(
    GEOCODING_BACKOFF_MINUTES * 2 ** Math.max(attempts - 1, 0),
    GEOCODING_BACKOFF_CAP_MINUTES,
  );
}

export {
  GEOCODING_BACKOFF_CAP_MINUTES,
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_MAX_ATTEMPTS,
  geocodingBackoffMinutes,
};
