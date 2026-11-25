import type { Prisma } from "@prisma/client";

import { UserNotAssignableError } from "./usecases/errors/user-not-assignable-error";

/**
 * Who can be handed a record: the responsible of a bill, of a service order
 * or of a vehicle, and the assignee of a Kanban card. Each of them is paged
 * about the record, so a login that can no longer sign in — access revoked,
 * or removed and anonymized (plano-escala F3-27) — must never be one.
 *
 * Audit of 11/2026: the picker (GET /user/search-user-business) listed both
 * and every save accepted them, so a bill's notices went to a login nobody
 * could open, and "Usuário removido" was offered as a responsible.
 */
type AssignableFields = {
  access_revoked?: boolean | null;
  anonymized_at?: Date | null;
};

/** The picker's filter, the same rule as isAssignableUser. */
const ASSIGNABLE_USER_WHERE = {
  access_revoked: false,
  anonymized_at: null,
} satisfies Prisma.UserWhereInput;

function isAssignableUser(user: AssignableFields): boolean {
  return !user.access_revoked && !user.anonymized_at;
}

/**
 * Refuses a person who can no longer sign in — unless the save keeps the
 * assignment the record already has (`keptUserId`). A bill registered by
 * someone who left still names them, and editing its amount must neither
 * fail nor silently hand it over: history keeps showing the old name, and
 * only a NEW choice has to be someone with access.
 *
 * Call it after the company check, so a foreign id still answers "not
 * found" (decision 11.3) and this never confirms that it exists.
 */
function assertAssignableUser(
  user: AssignableFields & { id: string },
  keptUserId?: string | null,
): void {
  if (keptUserId && user.id === keptUserId) return;

  if (!isAssignableUser(user)) throw new UserNotAssignableError();
}

export { ASSIGNABLE_USER_WHERE, assertAssignableUser, isAssignableUser };
