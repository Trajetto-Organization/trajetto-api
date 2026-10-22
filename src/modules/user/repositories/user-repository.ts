import database from "@/../infra/database";

import { forgetRequestCache, remember } from "@/shared/http/request-context";
import { Prisma } from "@prisma/client";

import { IUserRepository } from "./IUser-repository";

import {
  CreateUserProps,
  User,
  UpdateUserPassword,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  ListUsersPage,
  UpdateUser,
  UserRole,
  ListUsersByRoleAndBusinessProps,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  CreateMasterUserProps,
  ListMasterUsersProps,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
} from "../dtos/user-dto";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  USER_SORT,
  masterListWhere,
  userListWhere,
} from "../usecases/list-users/user-list";
import { insensitiveEquals } from "@/shared/utils/like-pattern";
import {
  MAX_FAILED_LOGINS,
  failureWindowStart,
  lockUntil,
} from "@/shared/security/login-lockout-rules";

/**
 * The user listings stream NDJSON, and a stream never passes through the
 * response serializer: whatever these queries return is exactly what leaves.
 * They selected the whole row, so every password hash of a company went to
 * any profile allowed to read its users. The hash stops here.
 */
function withoutPassword<T extends { password?: unknown }>(
  user: T,
): Omit<T, "password"> {
  const { password: _password, ...listed } = user;

  return listed;
}

class UserRepository implements IUserRepository {
  constructor(private prisma = database) {}

  async createUser({
    email,
    password,
    name,
    role,
    profileAccessId,
    businessId,
    driverId,
  }: CreateUserProps): Promise<User> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const userCreated = await this.prisma.user.create({
      data: {
        email,
        password: password as string,
        name,
        role,
        businessId,
        profileAccessId: profileAccessId || null,
        driverId: driverId || null,
      },
    });

    return userCreated;
  }

  async listUsers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListUsersByRoleAndBusinessProps): Promise<ListUsersPage> {
    const where = userListWhere(filters, { withFacets: true });

    // Two at a time (connection budget): the page ‖ the grouped counts over
    // the base; then, one after the other, the verified-address count and the
    // names of the profiles the groups mention.
    const [rows, grouped] = await Promise.all([
      this.prisma.user.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
        include: {
          profileAccess: { select: { name: true } },
          driver: { select: { name: true } },
        },
        orderBy: resolveOrderBy(USER_SORT, { sort, order }),
      }),
      this.prisma.user.groupBy({
        by: ["role", "access_revoked", "two_factor_enabled", "profileAccessId"],
        where: userListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const emailVerified = await this.prisma.user.count({
      where: { AND: [where, { email_verified: { not: null } }] },
    });

    const profileIds = Array.from(
      new Set([
        ...grouped.flatMap((group) =>
          group.profileAccessId ? [group.profileAccessId] : [],
        ),
        ...(filters.profileAccessIds ?? []),
      ]),
    );

    // Names only of this company's profiles: an id of another company in the
    // URL brings back neither a row nor a name.
    const profiles =
      profileIds.length > 0
        ? await this.prisma.profileAccess.findMany({
            where: { id: { in: profileIds }, businessId: filters.businessId },
            select: { id: true, name: true },
          })
        : [];

    return {
      data: rows.map(withoutPassword),
      groups: grouped.map((group) => ({
        role: group.role,
        access_revoked: group.access_revoked,
        two_factor_enabled: group.two_factor_enabled,
        profileAccessId: group.profileAccessId,
        count: group._count._all,
      })),
      profileNames: new Map(
        profiles.map((profile) => [profile.id, profile.name]),
      ),
      emailVerified,
    };
  }

  async updateEmailVerification({
    userId,
    email,
    email_verified,
  }: UpdateUserEmailVerification): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedEmailVerification = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email_verified,
        email,
      },
    });

    return updatedEmailVerification;
  }

  // `tx` lets callers update the user and an outbox event atomically.
  async updateUser(
    { userId, userData }: UpdateUser,
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    // Extract relation fields that need Prisma-specific translation. Nobody
    // sets another person's password through here any more (decision 4.9):
    // that goes through the single-use link and updateUserPassword.
    const {
      businessId,
      profileAccessId,
      driverId,
      userType: _userType,
      sendPasswordSetupLink: _sendPasswordSetupLink,
      ...restData
    } = userData;

    // Build Prisma update data from direct fields (excluding undefined values)
    const updateData: Prisma.UserUpdateInput = {};

    Object.entries(restData).forEach(([key, value]) => {
      if (value !== undefined) {
        (updateData as Record<string, unknown>)[key] = value;
      }
    });

    // Translate flat IDs to Prisma relation syntax
    // businessId: string → connect
    if (businessId) {
      updateData.business = {
        connect: { id: businessId },
      };
    }

    // profileAccessId: null → disconnect, string → connect, undefined → skip
    if (profileAccessId !== undefined) {
      updateData.profileAccess =
        profileAccessId === null
          ? { disconnect: true }
          : { connect: { id: profileAccessId } };
    }

    // driverId: null → disconnect, string → connect, undefined → skip
    if (driverId !== undefined) {
      updateData.driver =
        driverId === null
          ? { disconnect: true }
          : { connect: { id: driverId } };
    }

    const updatedUser = await (tx ?? this.prisma).user.update({
      where: { id: userId },
      data: updateData,
    });

    return updatedUser;
  }

  async deleteUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const deletedUser = await (tx ?? this.prisma).user.delete({
      where: { id: userId },
    });

    return deletedUser;
  }

  /**
   * Deletes a MASTER without leaving the platform with none.
   *
   * No Postgres constraint says "at least one MASTER row", so the rows are
   * locked instead: `FOR UPDATE` over the MASTERs serializes two concurrent
   * deletions, and the second counts after the first has deleted. Zero
   * MASTERs would lock the platform from the outside: only a MASTER creates
   * another.
   */
  async deleteMasterUserKeepingOne(
    userId: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<User | null> {
    forgetRequestCache();

    const deleteKeepingOne = async (tx: Prisma.TransactionClient) => {
      const masters = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "user" WHERE "role" = 'MASTER' FOR UPDATE
      `;

      if (masters.length <= 1) return null;

      // The target must be among the locked rows: a non-MASTER or an already
      // deleted id is a refusal, not a silent no-op.
      if (!masters.some((master) => master.id === userId)) return null;

      return tx.user.delete({ where: { id: userId } });
    };

    // The caller's transaction when it has one: the audit entry commits with
    // the deletion, and the locks are held until then (OUTBOX-10).
    return outerTx
      ? deleteKeepingOne(outerTx)
      : this.prisma.$transaction(deleteKeepingOne);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const findUserByEmail = await this.prisma.user.findFirst({
      where: {
        // Escaped: the value is an ILIKE pattern underneath, and "j_hn@..."
        // matched "john@..." at the login and the password reset
        // (like-pattern.ts).
        email: insensitiveEquals(email),
      },
      include: {
        business: {
          select: {
            is_active: true,
          },
        },
        profileAccess: {
          select: {
            name: true,
            permissions: {
              select: {
                id: true,
                permissionKey: true,
                action: true,
                canRead: true,
                canWrite: true,
              },
            },
          },
        },
      },
    });

    return findUserByEmail;
  }

  async findUserByEmailAndBusinessId(
    email: string,
    businessId: string,
  ): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        email: insensitiveEquals(email),
        businessId: businessId,
      },
      include: {
        profileAccess: {
          select: {
            name: true,
            permissions: {
              select: {
                id: true,
                permissionKey: true,
                action: true,
                canRead: true,
                canWrite: true,
              },
            },
          },
        },
      },
    });

    return user;
  }

  /**
   * The session lookup, answered once per request instead of twice.
   *
   * `ensureAuthenticated` loads the user to decide whether the session is
   * real, and then every use case loads it again because use cases take a
   * `userId` and look it up themselves. With the relations this carries that
   * is three queries, on every authenticated request in the product — 600 a
   * second at the measured saturation point, answering a question that was
   * answered a millisecond earlier.
   *
   * Memoised per REQUEST, never per process: a process-wide cache would mean
   * somebody revoking an access profile and the next N seconds of traffic
   * still seeing the old permissions. Inside one request the user cannot
   * change under itself — except by that same request writing to it, and
   * every write here calls `forgetRequestCache`.
   */
  async findUserById(userId: string): Promise<User | null> {
    return remember(`user:${userId}`, () => this.loadUserById(userId));
  }

  private async loadUserById(userId: string): Promise<User | null> {
    const findUserById = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        business: {
          select: {
            is_active: true,
            // Hired modules ride along with the session lookup: the web app
            // gates its navigation with them, and a second round trip on
            // every navigation would buy nothing.
            entitlements: {
              select: { module: true, enabled: true },
            },
          },
        },
        profileAccess: {
          select: {
            name: true,
            permissions: {
              select: {
                id: true,
                permissionKey: true,
                action: true,
                canRead: true,
                canWrite: true,
              },
            },
          },
        },
        // Everything the session check reads about the driver, so
        // assertSessionEligible does not load the driver a second time (with
        // its branch and its user) on every request a driver makes.
        driver: {
          select: {
            id: true,
            status: true,
            businessId: true,
            branchId: true,
            branch: { select: { is_active: true } },
          },
        },
      },
    });

    return findUserById;
  }

  async findUsersByBusiness(businessId: string): Promise<User[]> {
    const findUserByBusiness = await this.prisma.user.findMany({
      where: {
        businessId,
      },
    });

    return findUserByBusiness;
  }

  async countUsersWithProfile(profileAccessId: string): Promise<number> {
    return this.prisma.user.count({ where: { profileAccessId } });
  }

  async updateUserPassword({
    userId,
    password,
  }: UpdateUserPassword): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedUserPassword = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password,
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
        // Every session ends, so every device they registered stops receiving.
        PushDeviceToken: { deleteMany: {} },

        // A new password is the owner's way out of a lock somebody else
        // keeps renewing by guessing.
        failed_login_attempts: 0,
        failed_login_at: null,
        login_locked_until: null,
      },
    });

    return updatedUserPassword;
  }

  /**
   * One statement, so that concurrent wrong passwords are all counted: every
   * SET reads the row as it was before this UPDATE, and Postgres re-reads the
   * latest version when two of them wait on the same row.
   *
   * Raw on purpose: a failed login is not an edit of the user, and Prisma's
   * `update` would stamp `updated_at` on every guess.
   */
  async registerFailedLogin(userId: string, now: Date): Promise<void> {
    const windowStart = failureWindowStart(now);
    const lockedUntil = lockUntil(now);

    await this.prisma.$executeRaw`
      UPDATE "user"
      SET
        "failed_login_attempts" = CASE
          WHEN "failed_login_at" IS NULL OR "failed_login_at" < ${windowStart}
            THEN 1
          ELSE "failed_login_attempts" + 1
        END,
        "failed_login_at" = ${now},
        "login_locked_until" = CASE
          WHEN (CASE
            WHEN "failed_login_at" IS NULL OR "failed_login_at" < ${windowStart}
              THEN 1
            ELSE "failed_login_attempts" + 1
          END) >= ${MAX_FAILED_LOGINS}
            THEN ${lockedUntil}
          ELSE "login_locked_until"
        END
      WHERE "id" = ${userId}
    `;
  }

  async clearFailedLogins(userId: string, now: Date): Promise<boolean> {
    // Guarded by the lock itself: a burst of guesses may have locked the
    // account while this password was being compared, and that lock still
    // wins. Nothing to clear is the common case, and then nothing is written.
    //
    // One round trip: the outer SELECT reads the row as it was before the
    // CTE's UPDATE (a data-modifying CTE is invisible to its own statement).
    const [result] = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      WITH "cleared" AS (
        UPDATE "user"
        SET
          "failed_login_attempts" = 0,
          "failed_login_at" = NULL,
          "login_locked_until" = NULL
        WHERE "id" = ${userId}
          AND ("login_locked_until" IS NULL OR "login_locked_until" <= ${now})
          AND ("failed_login_attempts" > 0 OR "login_locked_until" IS NOT NULL)
        RETURNING "id"
      )
      SELECT EXISTS (
        SELECT 1 FROM "user"
        WHERE "id" = ${userId} AND "login_locked_until" > ${now}
      ) AS "locked"
    `;

    return !result?.locked;
  }

  async updateUserName({ userId, name }: UpdateUserName): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedUserName = await this.prisma.user.update({
      where: { id: userId },
      data: { name },
    });

    return updatedUserName;
  }

  async updateTwoFactorAuthentication({
    userId,
    isTwoFactorEnabled,
  }: UpdateTwoFactorAuthentication): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedTwoFactorAuthentication = await this.prisma.user.update({
      where: { id: userId },
      data: { two_factor_enabled: isTwoFactorEnabled },
    });

    return updatedTwoFactorAuthentication;
  }

  async toggleUserAccessRevocation(
    userId: string,
    expectedRevoked: boolean,
  ): Promise<boolean> {
    // Anything cached for this request describes the row before this write.
    forgetRequestCache();

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, access_revoked: expectedRevoked },
        data: { access_revoked: !expectedRevoked },
      });

      // A revoked person's phone stops receiving their pushes now, not when
      // the app next asks the API and learns it was revoked. Restoring access
      // brings nothing back: the app registers again on its next login.
      if (count === 1 && !expectedRevoked) {
        await tx.pushDeviceToken.deleteMany({ where: { userId } });
      }

      return count === 1;
    });
  }

  async updateUserAccessRevocation({
    userId,
    isAccessRevoke,
  }: UpdateUserAccessRevocation): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updateUserAccessRevocation = await this.prisma.user.update({
      where: { id: userId },
      data: {
        access_revoked: isAccessRevoke,
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
        PushDeviceToken: { deleteMany: {} },
      },
    });

    return updateUserAccessRevocation;
  }

  async invalidateUserSessions(userId: string): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
        // Forced logout of every session: their devices go too (MOB-05).
        PushDeviceToken: { deleteMany: {} },
      },
    });
  }

  async endSessionsAndClearInbox(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    forgetRequestCache();

    // One statement: the bump, the deletions and the caller's own write
    // commit or roll back together.
    await (tx ?? this.prisma).user.update({
      where: { id: userId },
      data: {
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
        PushDeviceToken: { deleteMany: {} },
        Notification: { deleteMany: {} },
        // What was fanned out to them and not delivered yet was addressed to
        // the old role or company: left in place, an IN_APP row would land in
        // the emptied inbox (another tenant's plates and values) and an
        // e-mail would carry it outside. DELIVERED and FAILED rows stay: they
        // are the ledger, and hold no message.
        NotificationDelivery: {
          deleteMany: { status: { in: ["PENDING", "PROCESSING"] } },
        },
      },
    });
  }

  async updateWhatsAppSettings({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedWhatsAppSettings = await this.prisma.user.update({
      where: { id: userId },
      data: {
        whatsapp_notifications_enabled: whatsapp_notifications_enabled,
        whatsapp_phone: whatsapp_phone || null,
      },
      include: {
        business: true,
        profileAccess: {
          include: {
            permissions: true,
          },
        },
      },
    });

    return updatedWhatsAppSettings;
  }

  async findBusinessAdminsByBusinessId(businessId: string): Promise<User[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        businessId,
        role: "BUSINESS_ADMIN",
        access_revoked: false,
      },
      include: {
        business: {
          select: {
            corporate_reason: true,
            is_active: true,
          },
        },
      },
      orderBy: {
        created_at: "asc",
      },
    });

    return admins;
  }

  async findDeliveryOperators(businessId: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        businessId,
        access_revoked: false,
        // A driver logs in as a BUSINESS_USER too, and holds delivery_manage
        // for the app: being linked to a driver record is what rules them out.
        driverId: null,
        OR: [
          { role: "BUSINESS_ADMIN" },
          {
            role: "BUSINESS_USER",
            profileAccess: {
              permissions: {
                some: {
                  permissionKey: "delivery_manage",
                  canRead: true,
                  canWrite: true,
                },
              },
            },
          },
        ],
      },
      include: {
        business: {
          select: {
            corporate_reason: true,
            is_active: true,
          },
        },
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
  }

  async findOtherMasters(excludeUserId: string): Promise<User[]> {
    const masters = await this.prisma.user.findMany({
      where: {
        role: "MASTER",
        access_revoked: false,
        id: { not: excludeUserId },
      },
      orderBy: {
        created_at: "asc",
      },
    });

    return masters;
  }

  async findUserWithWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        whatsapp_phone: phoneNumber,
        whatsapp_notifications_enabled: true,
        access_revoked: false,
        ...(excludeUserId && { id: { not: excludeUserId } }),
      },
    });

    return user;
  }

  async findUserByDriverId(driverId: string): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        driverId,
      },
      include: {
        profileAccess: {
          select: {
            name: true,
            permissions: {
              select: {
                id: true,
                permissionKey: true,
                action: true,
                canRead: true,
                canWrite: true,
              },
            },
          },
        },
      },
    });

    return user;
  }

  async updateAvatar(
    userId: string,
    avatarPath: string | null,
  ): Promise<User | null> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: avatarPath },
    });

    return updatedUser;
  }

  async createMasterUser(
    { name, email, password }: CreateMasterUserProps,
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    // Anything cached for this request describes the row before this
    // write. Kept, it would be read back by the next lookup in the
    // same request and reported as the current state.
    forgetRequestCache();

    const masterUser = await (tx ?? this.prisma).user.create({
      data: {
        name,
        email,
        password,
        role: "MASTER",
      },
    });

    return masterUser;
  }

  async listMasterUsers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListMasterUsersProps): Promise<ListUsersPage> {
    const where = masterListWhere(filters, { withFacets: true });

    const [rows, grouped] = await Promise.all([
      this.prisma.user.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
        orderBy: resolveOrderBy(USER_SORT, { sort, order }),
      }),
      this.prisma.user.groupBy({
        by: ["role", "access_revoked", "two_factor_enabled", "profileAccessId"],
        where: masterListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const emailVerified = await this.prisma.user.count({
      where: { AND: [where, { email_verified: { not: null } }] },
    });

    return {
      data: rows.map(withoutPassword),
      groups: grouped.map((group) => ({
        role: group.role,
        access_revoked: group.access_revoked,
        two_factor_enabled: group.two_factor_enabled,
        profileAccessId: group.profileAccessId,
        count: group._count._all,
      })),
      profileNames: new Map(),
      emailVerified,
    };
  }

  async searchUserWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchUserWithCursorProps): Promise<CursorPaginatedUser> {
    const term = search?.trim() ?? "";

    const items = await this.prisma.user.findMany({
      where: {
        businessId,
        ...(term &&
          buildSearchOr<Prisma.UserWhereInput>([
            { name: { contains: term, mode: "insensitive" as const } },
            { email: { contains: term, mode: "insensitive" as const } },
          ])),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      // The id breaks created_at ties, so a cursor never skips a row.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data: data.map(withoutPassword), nextCursor, hasMore };
  }
}

export { UserRepository };
