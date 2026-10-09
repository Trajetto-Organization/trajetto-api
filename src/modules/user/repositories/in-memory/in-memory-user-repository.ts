import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { Prisma } from "@prisma/client";
import { USER_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { v7 as uuidV7 } from "uuid";

import { IUserRepository } from "../IUser-repository";

import {
  afterFailedLogin,
  isLoginLocked,
} from "@/shared/security/login-lockout-rules";

import {
  CreateUserProps,
  ListUsersByRoleAndBusinessProps,
  ListUsersPage,
  ListUsersProps,
  UpdateTwoFactorAuthentication,
  UpdateUser,
  UpdateUserName,
  UpdateUserPassword,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  CreateMasterUserProps,
  ListMasterUsersProps,
  User,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
} from "../../dtos/user-dto";

import {
  LISTED_ROLES,
  USER_SORT_FALLBACK,
  rolesNamedBy,
  type UserGroupCount,
  type UserSortKey,
} from "../../usecases/list-users/user-list";

import type { SortOrder } from "@/shared/pagination/list-query";
import { compareForOrder } from "@/shared/pagination/in-memory-order";

import type { InMemoryUserTokensRepository } from "./in-memory-user-tokens-repository";

type StoredUser = User & { created_at?: Date; updated_at?: Date };

/** What the user row owns and Prisma deletes through its relations. */
interface OwnedRow {
  userId: string;
}

/** A profile as the listing needs it: its name, and whose it is. */
interface ProfileSeed {
  name: string;
  businessId: string;
}

/** A permission as the session lookup (findUserById) selects it. */
interface PermissionSeed {
  id: string;
  permissionKey: string;
  action: string;
  canRead: boolean;
  canWrite: boolean;
}

/** The company as the session lookup selects it. */
interface BusinessSeed {
  is_active: boolean;
  entitlements: { module: string; enabled: boolean }[];
}

/** The driver as the session lookup selects it. */
interface DriverSeed {
  id: string;
  status: string;
  businessId: string;
  branchId: string | null;
  branch: { is_active: boolean } | null;
}

/** A notification delivery addressed to a user (Prisma: NotificationDelivery). */
interface DeliverySeed {
  userId: string;
  status: "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED";
}

interface InMemoryUserRepositoryOptions {
  /**
   * The refresh-token twin, so ending sessions here ends them there, as the
   * nested `RefreshToken: { deleteMany }` does in Postgres.
   */
  tokens?: InMemoryUserTokensRepository;
}

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    { code: "P2002", clientVersion: "in-memory", meta: { target: [target] } },
  );
}

function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "An operation failed because it depends on one or more records that were required but not found.",
    { code: "P2025", clientVersion: "in-memory" },
  );
}

function withoutPassword<T extends { password?: unknown }>(
  user: T,
): Omit<T, "password"> {
  const { password: _password, ...listed } = user;

  return listed;
}

/** Postgres ILIKE '%term%' on a literal term: case-insensitive substring. */
function containsInsensitive(value: string | null | undefined, term: string): boolean {
  return (value ?? "").toLocaleLowerCase("pt-BR").includes(term.toLocaleLowerCase("pt-BR"));
}

const time = (value: Date | null | undefined) =>
  value ? new Date(value).getTime() : null;

/**
 * The Prisma repository's twin (TEST-PAR-3): the same filters, order,
 * uniqueness and side effects, so a unit test that passes here would pass
 * against Postgres. Where the real query reads a relation (a profile's name,
 * a driver's name) the twin reads the seeds below.
 */
class InMemoryUserRepository implements IUserRepository {
  public user: StoredUser[] = [];

  /** Push devices each user registered (Prisma: PushDeviceToken). */
  public pushDeviceTokens: OwnedRow[] = [];

  /** The in-app inbox (Prisma: Notification). */
  public notifications: OwnedRow[] = [];

  /** Access profiles by id, for the listing's names and its search. */
  public profiles = new Map<string, ProfileSeed>();

  /** Driver names by id, for the listing's column and its search. */
  public driverNames = new Map<string, string>();

  /** Each profile's permissions, for the session lookup. */
  public profilePermissions = new Map<string, PermissionSeed[]>();

  /** Companies by id, for the session lookup. */
  public businesses = new Map<string, BusinessSeed>();

  /** Drivers by id, for the session lookup. */
  public drivers = new Map<string, DriverSeed>();

  /** The notification ledger rows addressed to each user. */
  public notificationDeliveries: DeliverySeed[] = [];

  private readonly tokens?: InMemoryUserTokensRepository;

  constructor(options: InMemoryUserRepositoryOptions = {}) {
    this.tokens = options.tokens;
  }

  /** Every session ends: the refresh tokens and the push devices go. */
  private endSessions(userId: string): void {
    if (this.tokens) {
      this.tokens.refreshTokenItems = this.tokens.refreshTokenItems.filter(
        (item) => item.userId !== userId,
      );
    }

    this.pushDeviceTokens = this.pushDeviceTokens.filter(
      (row) => row.userId !== userId,
    );
  }

  private findIndex(userId: string): number {
    return this.user.findIndex((user) => user.id === userId);
  }

  async createUser({
    email,
    password,
    name,
    role,
    businessId,
    profileAccessId,
    driverId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: CreateUserProps): Promise<User> {
    // The table's unique indexes, as Postgres raises them.
    if (this.user.some((user) => user.email === email)) {
      throw uniqueViolation("email");
    }

    if (driverId && this.user.some((user) => user.driverId === driverId)) {
      throw uniqueViolation("driverId");
    }

    const now = new Date();
    const user: StoredUser = {
      ...USER_COLUMN_DEFAULTS,
      id: uuidV7(),
      role: role || "BUSINESS_USER",
      email,
      name,
      password: password || "default-password",
      businessId,
      profileAccessId: profileAccessId || null,
      driverId: driverId || null,
      two_factor_enabled: false,
      access_revoked: false,
      session_version: 0,
      email_verified: null,
      avatar: null,
      whatsapp_notifications_enabled: whatsapp_notifications_enabled ?? false,
      email_notifications_enabled: true,
      activity_notifications_enabled: true,
      whatsapp_phone: whatsapp_phone ?? null,
      created_at: now,
      updated_at: now,
    };

    this.user.push(user);
    return user;
  }

  private listRow(user: StoredUser): ListUsersProps {
    const profile = user.profileAccessId
      ? this.profiles.get(user.profileAccessId)
      : undefined;
    const driverName = user.driverId
      ? this.driverNames.get(user.driverId)
      : undefined;

    const row = {
      ...withoutPassword(user),
      // The real query selects only these names from the relations.
      profileAccess: profile ? { name: profile.name } : null,
      driver: driverName ? { name: driverName } : null,
      created_at: user.created_at ?? new Date(0),
      updated_at: user.updated_at ?? new Date(0),
    };

    return row as unknown as ListUsersProps;
  }

  private sortValue(user: StoredUser, key: UserSortKey): string | number | null {
    switch (key) {
      case "created_at":
        return time(user.created_at);
      case "updated_at":
        return time(user.updated_at);
      case "email_verified":
        return time(user.email_verified);
      case "name":
        return user.name;
      case "email":
        return user.email;
      case "role":
        return user.role;
      case "profileAccess":
        return user.profileAccessId
          ? (this.profiles.get(user.profileAccessId)?.name ?? null)
          : null;
      case "driverName":
        return user.driverId ? (this.driverNames.get(user.driverId) ?? null) : null;
    }
  }

  /** resolveOrderBy's semantics: the key, then created_at desc, then id desc. */
  private sorted(
    users: StoredUser[],
    sort: UserSortKey | undefined,
    order: SortOrder | undefined,
  ): StoredUser[] {
    const key = sort ?? USER_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : USER_SORT_FALLBACK.order);

    // The comparator every twin shares (table-infra contract): NULLs, dates
    // and code-point string order land where Postgres puts them.
    return [...users].sort(
      (a, b) =>
        compareForOrder(
          this.sortValue(a, key),
          this.sortValue(b, key),
          direction,
          // Unverified addresses stay at the end in both directions.
          key === "email_verified" ? "last" : undefined,
        ) ||
        compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
        compareForOrder(a.id, b.id, "desc"),
    );
  }

  private matchesSearch(user: StoredUser, search: string | undefined): boolean {
    const term = search?.trim() ?? "";

    if (!term) return true;

    const profileName = user.profileAccessId
      ? this.profiles.get(user.profileAccessId)?.name
      : undefined;
    const driverName = user.driverId ? this.driverNames.get(user.driverId) : undefined;

    return (
      containsInsensitive(user.id, term) ||
      containsInsensitive(user.name, term) ||
      containsInsensitive(user.email, term) ||
      containsInsensitive(profileName, term) ||
      containsInsensitive(driverName, term) ||
      (rolesNamedBy(term) as string[]).includes(user.role)
    );
  }

  private groupsOf(users: StoredUser[]): UserGroupCount[] {
    const groups = new Map<string, UserGroupCount>();

    for (const user of users) {
      const key = [
        user.role,
        user.access_revoked,
        user.two_factor_enabled ?? false,
        user.profileAccessId ?? "",
      ].join("|");

      const group = groups.get(key);

      if (group) {
        group.count += 1;
        continue;
      }

      groups.set(key, {
        role: user.role,
        access_revoked: user.access_revoked,
        two_factor_enabled: user.two_factor_enabled ?? false,
        profileAccessId: user.profileAccessId ?? null,
        count: 1,
      });
    }

    return Array.from(groups.values());
  }

  async listUsers({
    page,
    pageSize,
    sort,
    order,
    currentUserId,
    currentUserRole,
    businessId,
    search,
    roles,
    access,
    twoFactor,
    profileAccessIds,
  }: ListUsersByRoleAndBusinessProps): Promise<ListUsersPage> {
    const listed = LISTED_ROLES[currentUserRole] as readonly string[];

    const base = this.user.filter(
      (user) =>
        user.businessId === businessId &&
        listed.includes(user.role) &&
        user.id !== currentUserId &&
        this.matchesSearch(user, search),
    );

    const filtered = base.filter(
      (user) =>
        (!roles?.length || (roles as string[]).includes(user.role)) &&
        (access?.length !== 1 ||
          user.access_revoked === (access[0] === "revoked")) &&
        (twoFactor?.length !== 1 ||
          (user.two_factor_enabled ?? false) === (twoFactor[0] === "enabled")) &&
        (!profileAccessIds?.length ||
          (user.profileAccessId !== null &&
            user.profileAccessId !== undefined &&
            profileAccessIds.includes(user.profileAccessId))),
    );

    const skip = (page - 1) * pageSize;
    const pageRows = this.sorted(filtered, sort, order).slice(skip, skip + pageSize);

    const groups = this.groupsOf(base);

    const profileIds = new Set([
      ...groups.flatMap((group) => (group.profileAccessId ? [group.profileAccessId] : [])),
      ...(profileAccessIds ?? []),
    ]);

    // Only this company's profiles are named, as the real query's where says.
    const profileNames = new Map<string, string>();

    for (const id of profileIds) {
      const profile = this.profiles.get(id);
      if (profile && profile.businessId === businessId) profileNames.set(id, profile.name);
    }

    return {
      data: pageRows.map((user) => this.listRow(user)),
      groups,
      profileNames,
      emailVerified: filtered.filter((user) => user.email_verified).length,
    };
  }

  async updateUser({ userId, userData }: UpdateUser): Promise<User> {
    const index = this.findIndex(userId);

    if (index === -1) {
      throw recordNotFound();
    }

    const {
      userType: _userType,
      sendPasswordSetupLink: _sendPasswordSetupLink,
      ...columns
    } = userData;

    // Only skip undefined values — null is a valid value (means "clear/disconnect")
    const filteredData = Object.fromEntries(
      Object.entries(columns).filter(([, value]) => value !== undefined),
    );

    if (
      typeof filteredData.email === "string" &&
      this.user.some((user) => user.id !== userId && user.email === filteredData.email)
    ) {
      throw uniqueViolation("email");
    }

    if (
      typeof filteredData.driverId === "string" &&
      this.user.some(
        (user) => user.id !== userId && user.driverId === filteredData.driverId,
      )
    ) {
      throw uniqueViolation("driverId");
    }

    const updatedUser = {
      ...this.user[index],
      ...filteredData,
      updated_at: new Date(),
    } as StoredUser;

    this.user[index] = updatedUser;
    return updatedUser;
  }

  async endSessionsAndClearInbox(userId: string): Promise<void> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) throw recordNotFound();

    user.session_version = (user.session_version ?? 0) + 1;
    this.endSessions(userId);
    this.notifications = this.notifications.filter((row) => row.userId !== userId);

    // As the real one: what was not delivered yet goes; the ledger stays.
    this.notificationDeliveries = this.notificationDeliveries.filter(
      (row) =>
        row.userId !== userId ||
        (row.status !== "PENDING" && row.status !== "PROCESSING"),
    );
  }

  async deleteUser(userId: string): Promise<User> {
    const index = this.findIndex(userId);

    if (index === -1) {
      throw recordNotFound();
    }

    const deletedUser = this.user.splice(index, 1)[0];

    // ON DELETE CASCADE of what the row owns.
    this.endSessions(userId);
    this.notifications = this.notifications.filter((row) => row.userId !== userId);
    this.notificationDeliveries = this.notificationDeliveries.filter(
      (row) => row.userId !== userId,
    );

    return deletedUser;
  }

  async deleteMasterUserKeepingOne(userId: string): Promise<User | null> {
    // Count and delete together, as the real repository does: a twin that
    // deleted without counting would let the last-MASTER test pass broken.
    const masters = this.user.filter((entry) => entry.role === "MASTER");

    if (masters.length <= 1) return null;
    if (!masters.some((master) => master.id === userId)) return null;

    return this.deleteUser(userId);
  }

  /** Prisma's insensitiveEquals: the address, whatever its case. */
  async findUserByEmail(email: string): Promise<User | null> {
    const wanted = email.toLocaleLowerCase("en-US");

    return (
      this.user.find((user) => user.email.toLocaleLowerCase("en-US") === wanted) ??
      null
    );
  }

  /**
   * The row with the relations the real include loads (profile and its
   * permissions, company state, driver): null where the column is null, as
   * Prisma answers, and read from the seeds above where it is set. A link the
   * twin was not given stays out, and a relation a test put on the row
   * itself is kept.
   */
  async findUserById(userId: string): Promise<User | null> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) return null;

    const relations: Partial<User> = {};

    if (user.profileAccess === undefined) {
      const profile = user.profileAccessId
        ? this.profiles.get(user.profileAccessId)
        : undefined;

      if (!user.profileAccessId) relations.profileAccess = null;
      else if (profile) {
        relations.profileAccess = {
          name: profile.name,
          permissions: this.profilePermissions.get(user.profileAccessId) ?? [],
        };
      }
    }

    if (user.business === undefined) {
      const business = user.businessId ? this.businesses.get(user.businessId) : undefined;

      if (!user.businessId) relations.business = null;
      else if (business) relations.business = business;
    }

    if (user.driver === undefined) {
      const driver = user.driverId ? this.drivers.get(user.driverId) : undefined;

      if (!user.driverId) relations.driver = null;
      else if (driver) relations.driver = driver;
    }

    return { ...user, ...relations };
  }

  async updateUserPassword({
    userId,
    password,
  }: UpdateUserPassword): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.password = password;
    user.session_version = (user.session_version ?? 0) + 1;
    user.failed_login_attempts = 0;
    user.failed_login_at = null;
    user.login_locked_until = null;
    this.endSessions(userId);
    return user;
  }

  async registerFailedLogin(userId: string, now: Date): Promise<void> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) return;

    Object.assign(user, afterFailedLogin(user, now));
  }

  async clearFailedLogins(userId: string, now: Date): Promise<boolean> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) return true;
    if (isLoginLocked(user, now)) return false;

    user.failed_login_attempts = 0;
    user.failed_login_at = null;
    user.login_locked_until = null;
    return true;
  }

  async updateUserName({ userId, name }: UpdateUserName): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.name = name;
    return user;
  }

  async updateTwoFactorAuthentication({
    userId,
    isTwoFactorEnabled,
  }: UpdateTwoFactorAuthentication): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.two_factor_enabled = isTwoFactorEnabled;
    return user;
  }

  async updateEmailVerification({
    email,
    email_verified,
    userId,
  }: UpdateUserEmailVerification): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.email = email;
    user.email_verified = email_verified;

    return user;
  }

  async findUserByEmailAndBusinessId(
    email: string,
    businessId: string,
  ): Promise<User | null> {
    const wanted = email.toLocaleLowerCase("en-US");

    return (
      this.user.find(
        (user) =>
          user.email.toLocaleLowerCase("en-US") === wanted &&
          user.businessId === businessId,
      ) ?? null
    );
  }

  async findUsersByBusiness(businessId: string): Promise<User[]> {
    return this.user.filter((user) => user.businessId === businessId);
  }

  async countUsersWithProfile(profileAccessId: string): Promise<number> {
    return this.user.filter((user) => user.profileAccessId === profileAccessId).length;
  }

  /**
   * Mirrors the real precondition, including refusing.
   *
   * A fake that flipped unconditionally would let every test agree with a
   * repository that can refuse, and refusing is the whole point.
   */
  async toggleUserAccessRevocation(
    userId: string,
    expectedRevoked: boolean,
  ): Promise<boolean> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) return false;
    if ((user.access_revoked ?? false) !== expectedRevoked) return false;

    user.access_revoked = !expectedRevoked;

    // As the real one: a revoked person's phone stops receiving at once.
    if (!expectedRevoked) {
      this.pushDeviceTokens = this.pushDeviceTokens.filter(
        (row) => row.userId !== userId,
      );
    }

    return true;
  }

  async updateUserAccessRevocation({
    userId,
    isAccessRevoke,
  }: UpdateUserAccessRevocation): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.access_revoked = isAccessRevoke;
    user.session_version = (user.session_version ?? 0) + 1;
    this.endSessions(userId);
    return user;
  }

  async invalidateUserSessions(userId: string): Promise<User | null> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) throw recordNotFound();

    user.session_version = (user.session_version ?? 0) + 1;
    this.endSessions(userId);
    return user;
  }

  async updateWhatsAppSettings({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.whatsapp_notifications_enabled = whatsapp_notifications_enabled;
    // As the real one: an empty number is stored as null.
    user.whatsapp_phone = whatsapp_phone || null;

    return user;
  }

  /** Oldest first, never a revoked one: they receive nothing any more. */
  async findBusinessAdminsByBusinessId(businessId: string): Promise<User[]> {
    return this.sortedByCreation(
      this.user.filter(
        (user) =>
          user.businessId === businessId &&
          user.role === "BUSINESS_ADMIN" &&
          !user.access_revoked,
      ),
    );
  }

  /** As the Prisma query: admins, plus users whose profile writes deliveries. */
  async findDeliveryOperators(businessId: string): Promise<User[]> {
    const writesDeliveries = (user: StoredUser): boolean =>
      Boolean(
        user.profileAccessId &&
          (this.profilePermissions.get(user.profileAccessId) ?? []).some(
            (permission) =>
              permission.permissionKey === "delivery_manage" &&
              permission.canRead &&
              permission.canWrite,
          ),
      );

    // created_at asc, id asc: the Prisma order, tiebreaker included.
    return this.user
      .filter(
        (user) =>
          user.businessId === businessId &&
          !user.access_revoked &&
          !user.driverId &&
          (user.role === "BUSINESS_ADMIN" ||
            (user.role === "BUSINESS_USER" && writesDeliveries(user))),
      )
      .sort(
        (a, b) =>
          (time(a.created_at) ?? 0) - (time(b.created_at) ?? 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  async findOtherMasters(excludeUserId: string): Promise<User[]> {
    return this.sortedByCreation(
      this.user.filter(
        (user) =>
          user.role === "MASTER" && user.id !== excludeUserId && !user.access_revoked,
      ),
    );
  }

  private sortedByCreation(users: StoredUser[]): StoredUser[] {
    return [...users].sort(
      (a, b) => (time(a.created_at) ?? 0) - (time(b.created_at) ?? 0),
    );
  }

  async findUserByDriverId(driverId: string): Promise<User | null> {
    return this.user.find((user) => user.driverId === driverId) ?? null;
  }

  async findUserWithWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User | null> {
    // Mirrors the Prisma query: only enabled, non-revoked users hold a
    // number, so a kept number on a disabled account never blocks someone
    // else from using it.
    const findUser = this.user.find(
      (user) =>
        user.whatsapp_phone === phoneNumber &&
        user.whatsapp_notifications_enabled === true &&
        !user.access_revoked &&
        (excludeUserId ? user.id !== excludeUserId : true),
    );

    return findUser || null;
  }

  async updateAvatar(
    userId: string,
    avatarPath: string | null,
  ): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    // Prisma's update() raises P2025 for a missing row; it never answers null.
    if (!user) throw recordNotFound();

    user.avatar = avatarPath;
    return user;
  }

  async createMasterUser({
    name,
    email,
    password,
  }: CreateMasterUserProps): Promise<User> {
    if (this.user.some((user) => user.email === email)) {
      throw uniqueViolation("email");
    }

    const now = new Date();
    const masterUser: StoredUser = {
      ...USER_COLUMN_DEFAULTS,
      id: uuidV7(),
      name,
      email,
      password,
      role: "MASTER",
      businessId: null,
      profileAccessId: null,
      driverId: null,
      two_factor_enabled: false,
      access_revoked: false,
      session_version: 0,
      // Prisma leaves it null: the master confirms the address by link.
      email_verified: null,
      created_at: now,
      updated_at: now,
    };

    this.user.push(masterUser);
    return masterUser;
  }

  async listMasterUsers({
    page,
    pageSize,
    search,
    currentUserId,
    sort,
    order,
    access,
    twoFactor,
  }: ListMasterUsersProps): Promise<ListUsersPage> {
    const term = search?.trim() ?? "";

    const base = this.user.filter(
      (user) =>
        user.role === "MASTER" &&
        (!currentUserId || user.id !== currentUserId) &&
        (!term ||
          containsInsensitive(user.id, term) ||
          containsInsensitive(user.name, term) ||
          containsInsensitive(user.email, term)),
    );

    const filtered = base.filter(
      (user) =>
        (access?.length !== 1 ||
          user.access_revoked === (access[0] === "revoked")) &&
        (twoFactor?.length !== 1 ||
          (user.two_factor_enabled ?? false) === (twoFactor[0] === "enabled")),
    );

    const skip = (page - 1) * pageSize;

    return {
      data: this.sorted(filtered, sort, order)
        .slice(skip, skip + pageSize)
        .map((user) => withoutPassword(user) as unknown as ListUsersProps),
      groups: this.groupsOf(base),
      profileNames: new Map(),
      emailVerified: filtered.filter((user) => user.email_verified).length,
    };
  }

  async searchUserWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchUserWithCursorProps): Promise<CursorPaginatedUser> {
    const term = search?.trim() ?? "";

    let filtered = this.sorted(
      this.user.filter(
        (user) =>
          user.businessId === businessId &&
          (!term ||
            containsInsensitive(user.name, term) ||
            containsInsensitive(user.email, term)),
      ),
      undefined,
      undefined,
    );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.user, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data: data.map(withoutPassword), nextCursor, hasMore };
  }
}

export { InMemoryUserRepository };
