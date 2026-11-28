import type { User } from "../../dtos/user-dto";

import type { ISessionRepository, SessionLookup } from "../ISession-repository";

import type { InMemoryUserRepository } from "./in-memory-user-repository";
import type { InMemoryUserTokensRepository } from "./in-memory-user-tokens-repository";

/** Byte order, as COLLATE "C" sorts in the statement. */
const byteOrder = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * The twin of SessionRepository: the user as the user twin's findUserById
 * answers it and the family as the token twin's hasActiveRefreshTokenFamily
 * answers it, which is exactly what the one statement is held to
 * (tests/E2E/session-lookup-equivalence.test.ts). On top, the order the
 * statement fixes: permissions by id and hired modules by name. Copies, so
 * the seeds keep the order a test gave them.
 */
class InMemorySessionRepository implements ISessionRepository {
  constructor(
    private readonly users: InMemoryUserRepository,
    private readonly tokens: InMemoryUserTokensRepository,
  ) {}

  async loadSession(userId: string, familyId: string): Promise<SessionLookup> {
    const user = await this.users.findUserById(userId);

    if (!user) return { user: null, hasActiveFamily: false };

    return {
      user: ordered(user),
      hasActiveFamily: await this.tokens.hasActiveRefreshTokenFamily(
        userId,
        familyId,
      ),
    };
  }
}

function ordered(user: User): User {
  const { business, profileAccess } = user;

  return {
    ...user,
    ...(business && {
      business: {
        ...business,
        ...(business.entitlements && {
          entitlements: [...business.entitlements].sort((left, right) =>
            byteOrder(left.module, right.module),
          ),
        }),
      },
    }),
    ...(profileAccess && {
      profileAccess: {
        ...profileAccess,
        permissions: [...profileAccess.permissions].sort((left, right) =>
          byteOrder(left.id, right.id),
        ),
      },
    }),
  };
}

export { InMemorySessionRepository };
