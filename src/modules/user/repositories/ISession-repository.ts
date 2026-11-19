import type { User } from "../dtos/user-dto";

/**
 * What a request needs to know about the session its access token names.
 *
 * `user` is the user exactly as findUserById loads it (the company's state
 * and hired modules, the profile and its permissions, the driver and its
 * branch), or null when the id does not exist. `hasActiveFamily` is
 * hasActiveRefreshTokenFamily: the token's refresh-token family still has a
 * token that is neither revoked nor expired.
 */
interface SessionLookup {
  user: User | null;
  hasActiveFamily: boolean;
}

/**
 * The session lookup in one statement (plano-escala F4-04).
 *
 * Today ensureAuthenticated and the socket handshake ask two repositories
 * three to five questions on every request: the user with its company and
 * entitlements, the profile's permissions, the driver and its branch, and
 * the refresh-token family. This answers all of them in one round trip,
 * with the same shapes, so the checks that read them do not change.
 *
 * Never cached across requests: a revoked profile or an ended session must
 * be refused on the very next request (verify-tenant-active.ts).
 */
interface ISessionRepository {
  loadSession(userId: string, familyId: string): Promise<SessionLookup>;
}

export type { ISessionRepository, SessionLookup };
