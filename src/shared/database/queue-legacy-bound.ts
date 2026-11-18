import type { BatchDeleteClient } from "@/shared/database/batch-delete";
import { parsePartitionBound } from "@/shared/route/driver-position-rules";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * Below which id every row of `tables` is still in a legacy partition, the
 * plain table of before the swap (plano-escala F5-09): the smallest start
 * of a day partition among them, as the uuid v7 floor their bounds are
 * made of. Null while any of them is still a plain table.
 *
 * A queue's nightly purge in batches keeps to the rows under it once the
 * tables are partitioned (F5-11, F5-12): the days above it leave whole by
 * DETACH and DROP, and a DELETE there would be the dead rows and the WAL
 * the partitions exist to avoid. Once the legacy partitions are dropped
 * too, nothing is under the bound, and the batches find nothing.
 */
async function queueLegacyBound(
  db: BatchDeleteClient,
  tables: readonly string[],
): Promise<string | null> {
  const rows = await db.$queryRaw<
    Array<{ parent: string; partitioned: boolean; bound: string | null }>
  >`
    SELECT t.name AS parent,
           coalesce(p.relkind = 'p', false) AS partitioned,
           pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM unnest(${[...tables]}::text[]) AS t(name)
    LEFT JOIN pg_class p ON p.oid = to_regclass(quote_ident(t.name))
    LEFT JOIN pg_inherits i ON i.inhparent = p.oid
    LEFT JOIN pg_class c ON c.oid = i.inhrelid
  `;

  if (rows.length === 0 || rows.some((row) => !row.partitioned)) return null;

  const starts = rows
    .map((row) => (row.bound ? parsePartitionBound(row.bound)?.from : null))
    .filter(
      (from): from is number =>
        typeof from === "number" && Number.isFinite(from),
    );

  return starts.length > 0 ? uuid7Floor(Math.min(...starts)) : null;
}

export { queueLegacyBound };
