import type { SortOrder } from "@/shared/pagination/list-query";

import type { Prisma } from "@prisma/client";

import type { CreateUserRefreshTokenProps } from "./user-tokens-dto";

import type {
  MasterSortKey,
  UserGroupCount,
  UserListFilters,
  UserSortKey,
} from "../usecases/list-users/user-list";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

enum EnumUserRole {
  MASTER = "MASTER",
  BUSINESS_ADMIN = "BUSINESS_ADMIN",
  BUSINESS_USER = "BUSINESS_USER",
}

enum UserBusinessRole {
  BUSINESS_ADMIN = "BUSINESS_ADMIN",
  BUSINESS_USER = "BUSINESS_USER",
}

interface CreateUserProps {
  password?: string;
  /** Null or absent only for a driver's login (D02; D2 second release). */
  email?: string | null;
  name: string;
  role: UserRole;
  businessId: string;
  profileAccessId?: string | null;
  driverId?: string | null;
  whatsapp_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;

  /**
   * A driver's login created with the password the manager set (plan of
   * 02/11/2026, D2): nothing is mailed to confirm, so the address the
   * manager typed counts as confirmed from the start.
   */
  email_verified?: Date | null;

  /**
   * The same initial password (wave 2): the driver creates their own at the
   * first sign-in.
   */
  must_change_password?: boolean;
}

interface UpdateUserProps {
  email?: string | null;
  name?: string | null;
  role?: UserRole | null;
  businessId?: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
  userType?: "employee" | "driver";

  /**
   * MASTER only: e-mails the person a single-use link to set a new password
   * (decision 4.9). Nobody types another person's password any more, and no
   * password is ever mailed.
   */
  sendPasswordSetupLink?: boolean;
  whatsapp_notifications_enabled?: boolean | null;
  whatsapp_phone?: string | null;
}

interface UpdateUserEmailVerification {
  userId: string;
  email_verified: Date;
  email: string;
}

interface User {
  id: string;
  role: UserRole;
  email: string | null;
  email_verified?: Date | null;
  two_factor_enabled?: boolean;
  access_revoked: boolean;
  session_version?: number;
  password: string;
  name: string;
  avatar?: string | null;
  businessId?: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;

  /** Last time this user was seen connected — the chat's presence line. */
  last_seen_at?: Date | null;

  /** The per-account login brake (see shared/security/login-lockout-rules). */
  failed_login_attempts?: number;
  failed_login_at?: Date | null;
  login_locked_until?: Date | null;

  /**
   * The manager set the password (wave 2): the person creates their own at
   * the next sign-in. The clients enforce it; the API refuses nothing.
   */
  must_change_password?: boolean;
  profileAccess?: {
    name: string;
    permissions: {
      id: string;
      permissionKey: string;
      action: string;
      canRead: boolean;
      canWrite: boolean;
    }[];
  } | null;
  business?: {
    is_active: boolean;
    entitlements?: { module: string; enabled: boolean }[];
  } | null;

  /**
   * The linked driver, as the session lookup (findUserById) loads it: what
   * assertSessionEligible needs, so a driver's request does not load the
   * driver twice. Other lookups leave it out, or carry only id and status.
   */
  driver?: {
    id: string;
    status: string;
    businessId?: string;
    branchId?: string | null;
    branch?: { is_active: boolean } | null;
  } | null;

  /**
   * Sellable modules this session may use, resolved by the get-user usecase.
   * MASTER carries every module: the back office operates across companies.
   */
  enabledModules?: string[];
  whatsapp_notifications_enabled?: boolean;
  email_notifications_enabled?: boolean;
  activity_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;
}

/**
 * A driver's login found by the driver's CPF (plan of 02/11/2026, D8), with
 * what the CPF login reads: the password and lockout state, everything the
 * session check reads (company state, the driver with its branch), and the
 * name the company picker shows — the trade name, or the legal name when the
 * company has none.
 */
interface DriverLoginByCpf extends User {
  companyName: string;
}

interface UpdateUserPassword {
  userId: string;
  password: string;

  /**
   * Also stamps `email_verified` (plan of 02/11/2026, D1): the single-use
   * link that set this password reached the mailbox, which proves it. Left
   * out when the e-mail was already confirmed, so the first stamp stays.
   */
  markEmailVerifiedAt?: Date;

  /**
   * Whether the person must create their own password at the next sign-in
   * (wave 2): true when the manager set this one, false (the default) when
   * the person did.
   */
  mustChangePassword?: boolean;
}

/**
 * The person sets their own password and keeps the session they did it from
 * (wave 2): every other session ends, this one is re-issued.
 */
interface UpdateUserPasswordKeepingSession {
  userId: string;
  password: string;

  /** The caller's session (refresh-token family). */
  keepFamilyId: string;

  /**
   * The kept session's next refresh token, minted from the row as updated —
   * its new session_version is only known inside the write.
   */
  replacement: (user: User) => CreateUserRefreshTokenProps;

  /**
   * Writes that commit with the password, in its transaction (the outbox
   * event of a notice about it). The in-memory twin passes no client.
   */
  effects?: (tx: Prisma.TransactionClient, user: User) => Promise<void>;
}

interface PasswordKeptSession {
  user: User;

  /** The other sessions (families) that ended, for the socket. */
  endedFamilies: string[];
}

interface UpdateTwoFactorAuthentication {
  userId: string;
  isTwoFactorEnabled: boolean;
}

interface UpdateUserWhatsAppSettings {
  userId: string;
  whatsapp_notifications_enabled: boolean;
  whatsapp_phone?: string | null;
}

interface UpdateUserAccessRevocation {
  userId: string;
  isAccessRevoke: boolean;
}

interface UpdateUserName {
  userId: string;
  name: string;
}

interface AuthenticateUser {
  email: string;
  password: string;
}

interface ListUsersProps {
  id: string;
  role: UserRole;
  email: string | null;
  email_verified?: Date | null;
  two_factor_enabled?: boolean;
  access_revoked: boolean;
  name: string;
  avatar?: string | null;
  business?: {
    corporate_reason: string;
  } | null;
  businessId?: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
  profileAccess?: {
    name: string;
  } | null;
  driver?: {
    name: string;
  } | null;
  whatsapp_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ListUsers {
  data: ListUsersProps[];
  total: number;
}

/** One company's users, as a page plus the counts its cards and filters need. */
interface ListUsersByRoleAndBusinessProps extends UserListFilters {
  page: number;
  pageSize: number;
  sort?: UserSortKey;
  order?: SortOrder;
}

interface ListUsersPage {
  data: ListUsersProps[];
  /** Users per faceted combination over search + tenant (summarizeUserList). */
  groups: UserGroupCount[];
  /** Names of the company's profiles present in the groups or selected. */
  profileNames: Map<string, string>;
  /** Users with a verified e-mail under search + every filter. */
  emailVerified: number;
}

interface UpdateUser {
  userData: UpdateUserProps;
  userId: string;
}

interface CreateMasterUserProps {
  name: string;
  email: string;

  /** The stored hash. The use case sets an unusable one and mails a link. */
  password: string;
}

interface UpdateMasterUserProps {
  name?: string | null;
  email?: string | null;

  /** E-mails the master a single-use link to set a new password (4.9). */
  sendPasswordSetupLink?: boolean;
}

interface ListMasterUsersProps {
  page: number;
  pageSize: number;
  search?: string;
  currentUserId?: string;
  sort?: MasterSortKey;
  order?: SortOrder;
  access?: UserListFilters["access"];
  twoFactor?: UserListFilters["twoFactor"];
}

interface SearchUserWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /** The typed term: name or e-mail. */
  search?: string;
}

interface CursorPaginatedUser {
  // Streamed as is: never the password hash (see UserRepository).
  data: Omit<User, "password">[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  CreateUserProps,
  DriverLoginByCpf,
  UpdateUserPassword,
  UpdateUserPasswordKeepingSession,
  PasswordKeptSession,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  UpdateUserEmailVerification,
  User,
  AuthenticateUser,
  ListUsers,
  UpdateUser,
  UserBusinessRole,
  UserRole,
  UpdateUserProps,
  ListUsersByRoleAndBusinessProps,
  ListUsersPage,
  ListUsersProps,
  EnumUserRole,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  CreateMasterUserProps,
  UpdateMasterUserProps,
  ListMasterUsersProps,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
};
