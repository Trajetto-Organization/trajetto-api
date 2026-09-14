/**
 * Assembles the `OR` of a list search, dropping conditions that say nothing.
 *
 * An empty object inside a Prisma `OR` is not "no condition" — it is an empty
 * conjunction, which is TRUE. One `{}` therefore satisfies the whole `OR` on
 * its own and the entire search term is discarded: the operator types a
 * driver's name, gets the full list back, and is shown a total that has
 * nothing to do with what they asked for.
 *
 * They arrive the same way every time. A MASTER-only clause is written as a
 * spread inside an object literal —
 *
 *   { ...(role === "MASTER" ? { businessId: { contains: search } } : {}) }
 *
 * — which for everyone who is not a MASTER evaluates to exactly `{}`. Thirteen
 * of these were sitting in eight repositories, breaking search on eleven
 * endpoints for every non-MASTER user, which is to say for every real
 * customer. The correct spelling already existed elsewhere in the codebase
 * (`...(cond ? [{ X }] : [])`, spreading an ARRAY, so the absent case adds
 * nothing), but writing it correctly in twenty-seven places and in every place
 * added later is not something to rely on.
 *
 * Filtering here fixes the class instead of the instances, and keeps working
 * for code written after this. It does NOT reach a condition that is nested
 * but empty (`{ business: {} }`); none exists today, and such a thing would be
 * a different mistake.
 *
 * Tenant scope is untouched by any of this, and that is worth stating: in all
 * twenty-seven sites the `businessId` filter is a top-level key of the `where`
 * — in AND with this `OR`, never a member of it — so a tautological `OR` has
 * never been able to widen a query past the caller's own carrier. The bug is
 * search being ignored, not data leaking.
 */
function buildSearchOr<TCondition extends object>(
  conditions: TCondition[],
): { OR: TCondition[] } | Record<string, never> {
  const meaningful = conditions.filter(
    (condition) => Object.keys(condition).length > 0,
  );

  return meaningful.length > 0 ? { OR: meaningful } : {};
}

export { buildSearchOr };
