import { Prisma } from "@prisma/client";
import { uniqueTargetOf } from "@/shared/errors/prisma-error-meta";

/**
 * Whether a P2002 was raised by a unique index covering `field`.
 *
 * A delivery row has three unique keys (NF-e key, submission key, and the id)
 * and each race means something different: a replayed submission is the same
 * delivery, a taken NF-e key is a conflict to report. Prisma 6 named the
 * index columns (an array); Prisma 7 names the index
 * (`delivery_businessId_invoice_key_key`), which contains the column — see
 * uniqueTargetOf.
 */
function violatesUniqueOn(error: unknown, field: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = uniqueTargetOf(error);

  if (Array.isArray(target)) return target.includes(field);

  return typeof target === "string" && target.includes(field);
}

export { violatesUniqueOn };
