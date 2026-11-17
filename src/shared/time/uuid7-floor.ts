/**
 * uuid v7 as a time key (plano-escala F2-16).
 *
 * A uuid v7 starts with its millisecond timestamp, 48 bits in hex, so its
 * text sorts in time order: the trail and, later, the activity and the
 * queues are partitioned by RANGE on their id, with each month's bounds
 * the smallest id that month can carry. Same technique as eventIdFloor
 * (integration-repository.ts) and deliveryIdFloor (metrics-queries.ts).
 *
 * The bound is compared under the column's collation (the database's
 * en_US.utf8, not "C"): the queries prune partitions only when they compare
 * in the key's own collation, so the key keeps the default. Every id has
 * its hyphens in the same places and only lower-case hex digits, which
 * sort the same under both.
 */

/** The smallest uuid v7 a row minted at or after `at` can carry. */
function uuid7Floor(at: Date | number): string {
  const ms = typeof at === "number" ? at : at.getTime();
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

const UUID7_PREFIX =
  /^([0-9a-f]{8})-([0-9a-f]{4})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The millisecond a uuid v7 (or a floor) starts with; null for text that
 * is not shaped like a uuid.
 */
function uuid7Instant(id: string): number | null {
  const match = UUID7_PREFIX.exec(id);

  return match ? parseInt(`${match[1]}${match[2]}`, 16) : null;
}

export { uuid7Floor, uuid7Instant };
