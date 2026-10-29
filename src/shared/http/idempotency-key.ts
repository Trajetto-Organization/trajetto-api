import { Prisma } from "@prisma/client";

import { submissionKeyOf } from "./submission-key";

/**
 * The `Idempotency-Key` a panel create was sent with, when it is a UUID.
 *
 * The web keeps one key per form (IDEMP-14): a server action that lost the
 * API's answer after the commit, and the user pressing "Salvar" again, send
 * the same key, and the record already created is the answer. Optional, and
 * read from a header rather than the body, so a web older than this API — or
 * an API older than this web — simply ignores it: the create works exactly as
 * before, only without the guard.
 */
function idempotencyKeyOf(
  headers: Record<string, unknown>,
): string | undefined {
  return submissionKeyOf(undefined, headers["idempotency-key"]);
}

/**
 * A unique index refused the insert — for these creates, the one on
 * (businessId, client_submission_id): the twin of this submission committed
 * after the replay check and before the insert.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export { idempotencyKeyOf, isUniqueViolation };
