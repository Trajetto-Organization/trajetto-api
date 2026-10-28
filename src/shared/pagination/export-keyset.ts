/**
 * The batches of a streamed export, in creation order: (created_at, id).
 *
 * The same keyset the delivery export uses (delivery-repository.ts). The
 * fleet exports paged with Prisma's `cursor` over `id`, which Prisma sends as
 * a sub-select: the planner never sees the value, and no index leads with
 * (businessId, id), so each batch either sorted the whole company or walked
 * the primary key through every other company's rows. Every exported table
 * here has (businessId, created_at): with the value as a literal bound, a
 * batch starts where the last one ended.
 */

/** Where an export batch ended: the last row's position in creation order. */
interface ExportKey {
  created_at: Date;
  id: string;
}

/** The order the batches are read in; the id breaks the tie. */
const EXPORT_ORDER = [{ created_at: "asc" }, { id: "asc" }] as const;

/**
 * The rows that come after `after` in (created_at, id) order.
 *
 * The second condition alone is the keyset. The first says the same thing in
 * a form the planner can use: `created_at >= x` becomes the lower bound of
 * the (businessId, created_at) index scan.
 */
function keysetAfter(after: ExportKey) {
  return [
    { created_at: { gte: after.created_at } },
    {
      OR: [
        { created_at: { gt: after.created_at } },
        { created_at: after.created_at, id: { gt: after.id } },
      ],
    },
  ];
}

/**
 * The `where` of the batch after `after` (the first batch: `where` itself),
 * typed as the model's own where input: Prisma accepts the AND of the
 * listing's condition and the keyset on every model with these columns.
 */
function exportBatchWhere<W extends object>(
  where: W,
  after: ExportKey | null,
): W {
  return after
    ? ({ AND: [where, ...keysetAfter(after)] } as unknown as W)
    : where;
}

/** The in-memory twins' order: created_at, then the id in code-point order. */
function compareExportKeys(
  a: { created_at: Date | string; id: string },
  b: { created_at: Date | string; id: string },
): number {
  const byTime =
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

  if (byTime !== 0) return byTime;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export {
  EXPORT_ORDER,
  compareExportKeys,
  exportBatchWhere,
  keysetAfter,
  type ExportKey,
};
