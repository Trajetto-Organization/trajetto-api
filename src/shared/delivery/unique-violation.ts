import { Prisma } from "@prisma/client";

/**
 * Whether a P2002 was raised by a unique index covering `field`.
 *
 * A delivery row has three unique keys (NF-e key, submission key, and the id)
 * and each race means something different: a replayed submission is the same
 * delivery, a taken NF-e key is a conflict to report. Prisma names the index
 * columns in `meta.target` (an array) or, for a raw index, the index name.
 */
function violatesUniqueOn(error: unknown, field: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (Array.isArray(target)) return target.includes(field);

  return typeof target === "string" && target.includes(field);
}

export { violatesUniqueOn };
