import type { Prisma } from "@prisma/client";

import { adoptSessionVersion, sendSecurityEventToSession } from "@/websocket";

import type { User } from "../dtos/user-dto";
import type { UserSessionFamily } from "../dtos/user-tokens-dto";
import type { IUserRepository } from "../repositories/IUser-repository";
import {
  type HeaderSessionClient,
  type SessionClient,
  type SessionTokenPair,
  familyStartedAtOf,
  issueSessionTokenPair,
} from "./session-service";

interface KeptSessionTokens {
  token: string;
  refresh_token: string;
}

interface SetPasswordKeepingSessionProps {
  userId: string;
  /** Already hashed. */
  passwordHash: string;
  /** The caller's live session (IUsersTokensRepository.findSessionFamily). */
  family: UserSessionFamily;
  /** What the request's x-trajetto-client header asks for. */
  client: HeaderSessionClient;
  /**
   * Writes that commit with the password, in its transaction: the outbox
   * event of a notice about it.
   */
  effects?: (tx: Prisma.TransactionClient, user: User) => Promise<void>;
}

/**
 * The person sets their own password and keeps the session they did it from
 * (wave 2, 06/11/2026; owner's decision: changing the password from the app
 * keeps the current session and ends the others).
 *
 * The password change still bumps session_version — the one number every
 * access token, refresh and socket of the account is checked against — so
 * every other session dies at its next request. This one is re-issued with
 * the new version: its live refresh token is deleted (a renewal racing the
 * change then finds nothing, instead of tripping the reuse alarm) and a new
 * one stored in the same family, under the same policy, all in the
 * password's transaction;
 * the answer carries the new pair, which a client that knows it adopts. The
 * other sessions hear `password_changed` in their own rooms only, and this
 * session's sockets adopt the new version instead of being swept.
 *
 * The policy is the family's: a phone id on its rows means the phone-bound
 * session, bound to the same phone; otherwise the header decides, which only
 * chooses between the web's day and the app's week — no more than a login
 * with the password just proven would get. The family keeps its birth
 * (familyStartedAtOf), so its cap never moves.
 *
 * The family was checked live before this runs, outside its transaction;
 * if it ended in between, the write finds none of its live tokens and
 * throws KeptSessionEndedError with nothing written (IUserRepository), and
 * the caller goes on as for a session that was not live.
 */
async function setPasswordKeepingSession(
  users: Pick<IUserRepository, "updateUserPasswordKeepingSession">,
  {
    userId,
    passwordHash,
    family,
    client,
    effects,
  }: SetPasswordKeepingSessionProps,
): Promise<KeptSessionTokens> {
  const policy: SessionClient = family.device_id ? "driver_device" : client;

  // Every family since 10/08/2026 has a UUIDv7 id; an older one (none can be
  // alive under a capped policy) falls back to its oldest stored row.
  const familyStartedAt =
    familyStartedAtOf(family.family_id) ??
    Math.floor(family.first_issued_at.getTime() / 1000);

  const issued: { pair?: SessionTokenPair } = {};

  const { user, endedFamilies } = await users.updateUserPasswordKeepingSession({
    userId,
    password: passwordHash,
    keepFamilyId: family.family_id,
    replacement: (updated) => {
      const pair = issueSessionTokenPair(updated, family.family_id, {
        client: policy,
        familyStartedAt,
        deviceId: family.device_id,
      });

      issued.pair = pair;

      return {
        userId,
        expires_in: pair.expiresAt,
        token_hash: pair.refreshTokenHash,
        jti: pair.refreshJti,
        family_id: pair.familyId,
        device_id: pair.deviceId,
      };
    },
    effects,
  });

  for (const familyId of endedFamilies) {
    sendSecurityEventToSession(familyId, { reason: "password_changed" });
  }

  adoptSessionVersion(family.family_id, user.session_version ?? 0);

  // Minted inside the write, which succeeded.
  const pair = issued.pair as SessionTokenPair;

  return { token: pair.token, refresh_token: pair.refresh_token };
}

export { setPasswordKeepingSession };
export type { KeptSessionTokens };
