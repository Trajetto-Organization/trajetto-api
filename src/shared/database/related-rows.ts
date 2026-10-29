/**
 * Related rows read the way Prisma 6 read an include: one query for the keys
 * the parent rows carry, and none when they carry none.
 *
 * Prisma 7 runs every relation of an include even when there is nothing to
 * look up — `WHERE "id" = $1` with a null foreign key, `IN (NULL)` under an
 * empty list — one statement per relation and per level. A delivery list
 * without vehicles paid for a vehicle query on every page, and a tower on a
 * quiet morning for five lookups under an empty feed. The hot reads load
 * those relations through here and attach them in the shape the include
 * returned: the related row, or null.
 */

/**
 * The rows `load` returns for the distinct keys present, by `keyOf` (the id
 * by default). No keys, no query.
 */
async function rowsByKey<Row>(
  keys: Iterable<string | null | undefined>,
  load: (keys: string[]) => Promise<Row[]>,
  keyOf: (row: Row) => string = (row) => (row as { id: string }).id,
): Promise<Map<string, Row>> {
  const distinct = [
    ...new Set([...keys].filter((key): key is string => key != null)),
  ];

  if (distinct.length === 0) return new Map();

  const rows = await load(distinct);

  return new Map(rows.map((row) => [keyOf(row), row]));
}

/** The row a key names, or null: what the include gave for a missing one. */
function relatedTo<Row>(
  rows: Map<string, Row>,
  key: string | null | undefined,
): Row | null {
  return key == null ? null : (rows.get(key) ?? null);
}

/**
 * A to-many relation read flat, back under its parents: each group keeps the
 * order the rows were read in, as the include's did.
 */
function groupedBy<Row>(
  rows: Row[],
  keyOf: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);

    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return groups;
}

export { groupedBy, relatedTo, rowsByKey };
