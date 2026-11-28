import { env } from "@/env";
import { rememberRow } from "@/shared/http/request-context";
import { rememberBusinessZone } from "@/shared/time/business-time-zone";

import type { User } from "../dtos/user-dto";

import { SessionRepository } from "../repositories/session-repository";
import {
  UserRepository,
  userRequestKey,
} from "../repositories/user-repository";
import { UserTokensRepository } from "../repositories/user-tokens-repository";

/**
 * The session an access token names, as ensureAuthenticated and the socket
 * handshake check it.
 *
 * `user` is findUserById's user, or null when the id does not exist.
 * `familyActive` answers whether the token's refresh-token family still has
 * a live token; the callers ask it last, after the version and the
 * eligibility, so a session refused for two reasons is refused with the
 * same code in both modes.
 */
interface LoadedSession {
  user: User | null;
  familyActive(): Promise<boolean>;
}

/**
 * The session lookup, by SESSION_LOOKUP_MODE (plano-escala F4-05).
 *
 * `single` (the default): SessionRepository.loadSession, one statement for
 * the user with its company, profile and driver and for the family, where
 * the old path ran two to six on every authenticated request and every
 * handshake. The user is left in the request's memory, so the use case and
 * the gates of the same request do not read it again.
 *
 * `legacy`: the old path, two releases as the rollback (U-10 removes it).
 * The family is asked only when the caller gets that far, as before.
 *
 * The mode is read on every call, never cached: flipping it is a redeploy
 * in a deployment, and a test may flip it between requests. Neither mode
 * keeps anything across requests: a revoked profile or an ended session is
 * refused on the very next one.
 */
async function lookUpSession(
  userId: string,
  familyId: string,
): Promise<LoadedSession> {
  if (env.SESSION_LOOKUP_MODE === "legacy") {
    const user = await new UserRepository().findUserById(userId);

    return {
      user,
      familyActive: () =>
        new UserTokensRepository().hasActiveRefreshTokenFamily(
          userId,
          familyId,
        ),
    };
  }

  const { user, hasActiveFamily } = await new SessionRepository().loadSession(
    userId,
    familyId,
  );

  return { user, familyActive: async () => hasActiveFamily };
}

/**
 * A session served by the session cache (plano-escala F5-23): its user is
 * left in this request's memory exactly as the one-statement lookup leaves
 * it, so the use case and the gates of the request read it from there
 * instead of asking findUserById for it (which, with its relations, costs
 * more than the lookup the cache saved). The copy is the request's own.
 */
function reuseSessionUser(user: User): void {
  rememberRow(userRequestKey(user.id), user);
  rememberBusinessZone(user.businessId, user.business);
}

export { lookUpSession, reuseSessionUser };
export type { LoadedSession };
