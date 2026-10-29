import { AppError } from "@/shared/errors/AppError";

/**
 * Who owns an object the client uploaded with a presigned PUT, when the
 * request that was supposed to reference it does not end in a new row.
 *
 * Both creation paths (fueling, checklist) used to delete "this attempt's"
 * uploads on ANY failure before the commit and on every idempotent replay.
 * But the app's outbox retries with the SAME keys — it records each key once
 * uploaded and never uploads it again — so:
 *
 *  - a transient failure (pool timeout, serialization retries exhausted, a
 *    dropped connection) deleted the photos, and the retry came back 400
 *    UPLOADED_FILE_NOT_FOUND, which the app treats as final: the driver's
 *    finished checklist or fueling lost for good;
 *  - a replay racing the original found the row the original committed and
 *    deleted ITS photos — the committed record pointing at nothing, the
 *    evidence the AI check reads gone in silence.
 *
 * An object nobody references costs a few kilobytes of storage. A record
 * whose evidence was deleted cannot be rebuilt.
 */

/**
 * Whether a failure is a verdict on the request itself — one that retrying
 * with the same keys cannot change. Only then do its uploads belong to
 * nothing.
 */
function isFinalRejection(
  error: unknown,
  domainRejections: Array<abstract new (...args: never[]) => Error> = [],
): boolean {
  if (error instanceof AppError) {
    return error.statusCode >= 400 && error.statusCode < 500;
  }

  return domainRejections.some((Kind) => error instanceof Kind);
}

/** The keys this attempt uploaded that the existing record does not use. */
function unreferencedKeys(
  uploaded: string[],
  referenced: Iterable<string | null | undefined>,
): string[] {
  const kept = new Set<string>();

  for (const key of referenced) if (key) kept.add(key);

  return uploaded.filter((key) => !kept.has(key));
}

/** Every key a checklist row points at: `photos` and each field's list. */
function checklistPhotoKeys(checklist: {
  photos?: unknown;
  photos_by_field?: unknown;
}): string[] {
  const keys: string[] = [];

  if (Array.isArray(checklist.photos)) {
    for (const key of checklist.photos) {
      if (typeof key === "string") keys.push(key);
    }
  }

  const byField = checklist.photos_by_field;

  if (byField && typeof byField === "object" && !Array.isArray(byField)) {
    for (const value of Object.values(byField as Record<string, unknown>)) {
      for (const key of Array.isArray(value) ? value : [value]) {
        if (typeof key === "string") keys.push(key);
      }
    }
  }

  return keys;
}

export { checklistPhotoKeys, isFinalRejection, unreferencedKeys };
