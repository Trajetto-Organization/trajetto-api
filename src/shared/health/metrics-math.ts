/**
 * The arithmetic behind the capacity panel.
 *
 * Two ratios, and both of them drive a badge that turns red at a threshold —
 * 70% and 90% for connections, 20% for dead tuples. A ratio computed the wrong
 * way round does not look broken: it looks like a healthy system, right up to
 * the day it is the reason nobody was warned.
 *
 * Pure, and apart from the route, for one practical reason. Producing the
 * INPUTS from a live database is a fight with Postgres rather than with the
 * product: the queue tables start nearly empty, autovacuum's threshold is
 * fifty dead rows, and a counter seeded on purpose is back to zero before the
 * request goes out. Here the interesting case — more dead rows than live ones
 * — is one line.
 */

/**
 * How much of the connection ceiling is in use.
 *
 * Usage, never headroom: 90% means the database is about to start refusing
 * connections, not that it has plenty left.
 */
function connectionUsagePercent(active: number, max: number): number {
  if (max <= 0) return 0;

  return Math.round((active / max) * 100);
}

/**
 * How much of a table is rows waiting to be vacuumed.
 *
 * Against the TOTAL, not against the live rows. The difference only shows up
 * where it matters: a table with 100 live and 900 dead is 90% bloat by the
 * right formula and 900% by the wrong one, and a table whose rows are all dead
 * divides by zero.
 */
function deadTuplePercent(live: number, dead: number): number {
  const total = live + dead;

  if (total <= 0) return 0;

  return Math.round((dead / total) * 100);
}

export { connectionUsagePercent, deadTuplePercent };
