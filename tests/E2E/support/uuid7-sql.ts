/**
 * SQL for a random uuid v7 minted at the timestamp expression `at`, for
 * seeds that write the queues in bulk with INSERT … SELECT.
 *
 * The four queues are partitioned by day on RANGE(id) since the swap of
 * plano-escala F5-09, which every E2E database has run. A v4 id
 * (gen_random_uuid) is random from its first digit: it lands in no
 * partition and the INSERT fails, as it would in production
 * (tests/unitaires/database/queue-ids-v7-guard.test.ts keeps src/ on v7).
 * So a seed mints its ids like the code does: the millisecond of `at` in
 * the first 48 bits, version 7, and the random rest of a v4.
 *
 * `at` is a timestamp or timestamptz expression (`now()`, a column, a
 * computed instant); a `timestamp` column holds UTC, as Prisma writes it.
 */
function uuid7Sql(at = "now()"): string {
  const hex = `lpad(to_hex(floor(extract(epoch FROM ${at}) * 1000)::bigint), 12, '0')`;

  return `overlay(overlay(gen_random_uuid()::text PLACING '7' FROM 15 FOR 1) PLACING (substr(${hex}, 1, 8) || '-' || substr(${hex}, 9, 4)) FROM 1 FOR 13)`;
}

export { uuid7Sql };
