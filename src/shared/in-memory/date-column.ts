/**
 * What a Postgres `date` column (`@db.Date`) keeps of a value Prisma writes:
 * its UTC day, read back as midnight UTC of that day.
 *
 * The in-memory repositories store rows as given; without this they would
 * keep 2026-09-17T03:00:00Z where the database keeps 2026-09-17T00:00:00Z,
 * and a unit test could pass on a value the real table never holds
 * (decision 13.2: the fake and the database must agree).
 * tests/E2E/schema-expand-contract.test.ts pins the database side.
 */
function asDateColumn<T extends Date | string | null | undefined>(
  value: T,
): T extends Date | string ? Date : T {
  if (value === null || value === undefined) {
    return value as T extends Date | string ? Date : T;
  }

  const instant = new Date(value);

  return new Date(
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ),
  ) as T extends Date | string ? Date : T;
}

export { asDateColumn };
