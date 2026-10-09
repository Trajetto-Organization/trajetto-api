import { Prisma } from "@prisma/client";

import {
  CreateUserProps,
  User,
  UpdateUserPassword,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  ListUsersPage,
  UpdateUser,
  ListUsersByRoleAndBusinessProps,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  CreateMasterUserProps,
  ListMasterUsersProps,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
} from "../dtos/user-dto";

interface IUserRepository {
  createUser: ({ email, password, name }: CreateUserProps) => Promise<User>;
  listUsers: (
    listUsersProps: ListUsersByRoleAndBusinessProps,
  ) => Promise<ListUsersPage>;
  updateEmailVerification: ({
    email,
    email_verified,
    userId,
  }: UpdateUserEmailVerification) => Promise<User | null>;
  updateUser: (
    update: UpdateUser,
    tx?: Prisma.TransactionClient,
  ) => Promise<User>;
  // `tx`: the deletion and its audit entry commit together (OUTBOX-10).
  deleteUser: (userId: string, tx?: Prisma.TransactionClient) => Promise<User>;

  /**
   * Deletes a MASTER, never the last one.
   *
   * `null` when the deletion would leave the platform without one, or the
   * target is not a MASTER. Count-then-delete is not enough: two concurrent
   * deletions of different MASTERs read the same total and both pass — and
   * only a MASTER can create another.
   *
   * With `tx`, it runs inside the caller's transaction (the audit entry
   * joins it, OUTBOX-10).
   */
  deleteMasterUserKeepingOne: (
    userId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<User | null>;
  findUserByEmail: (email: string) => Promise<User | null>;
  findUserByEmailAndBusinessId: (
    email: string,
    businessId: string,
  ) => Promise<User | null>;
  findUserById: (userId: string) => Promise<User | null>;
  findUsersByBusiness: (businessId: string) => Promise<User[]>;

  /** How many users an access profile is linked to (the delete guard). */
  countUsersWithProfile: (profileAccessId: string) => Promise<number>;
  updateUserPassword: ({
    userId,
    password,
  }: UpdateUserPassword) => Promise<User | null>;

  /**
   * Counts one wrong password, and locks the account when that reaches the
   * ceiling — in one statement, so concurrent guesses are all counted.
   * See shared/security/login-lockout-rules.
   */
  registerFailedLogin: (userId: string, now: Date) => Promise<void>;

  /**
   * Clears the count after a right password, unless the account is locked
   * right now. Returns false when it is: a lock that landed while this
   * password was being checked still refuses it.
   */
  clearFailedLogins: (userId: string, now: Date) => Promise<boolean>;
  updateUserName: ({ userId, name }: UpdateUserName) => Promise<User | null>;
  updateTwoFactorAuthentication: ({
    userId,
    isTwoFactorEnabled,
  }: UpdateTwoFactorAuthentication) => Promise<User | null>;

  /**
   * Revokes or restores only if the flag is still where the caller saw it.
   *
   * Two administrators acting on the same account at once — one revoking, one
   * restoring — both read the old value and both wrote. Whichever query landed
   * last decided the row, while BOTH pushed a security event down the socket:
   * the user could be told "your access was restored" and stay locked out, or
   * the reverse. The state that was read is now the precondition for the
   * write, so the second one changes nothing and says so.
   *
   * Returns false when the precondition did not hold.
   */
  toggleUserAccessRevocation: (
    userId: string,
    expectedRevoked: boolean,
  ) => Promise<boolean>;

  updateUserAccessRevocation: ({
    userId,
    isAccessRevoke,
  }: UpdateUserAccessRevocation) => Promise<User | null>;
  invalidateUserSessions: (userId: string) => Promise<User | null>;

  /**
   * What a change of role, company or driver link does to the person
   * (decision 4.6): every session ends (session_version bumps, refresh tokens
   * and push devices go) and the inbox is emptied — its notifications were
   * addressed to the role or company they no longer have, with links that no
   * longer open. Activities stay: they are the audit trail.
   *
   * Takes the caller's transaction so it commits with the change itself.
   */
  endSessionsAndClearInbox: (
    userId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
  updateWhatsAppSettings: ({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings) => Promise<User | null>;
  findBusinessAdminsByBusinessId: (businessId: string) => Promise<User[]>;
  /**
   * Who runs the company's deliveries (DLVP-NOTIF-1): its administrators plus
   * every BUSINESS_USER whose profile writes `delivery_manage` — the tower's
   * operators. Never a driver account, never a revoked one. Oldest first.
   */
  findDeliveryOperators: (businessId: string) => Promise<User[]>;
  findOtherMasters: (excludeUserId: string) => Promise<User[]>;
  findUserWithWhatsAppByPhone: (
    phoneNumber: string,
    excludeUserId?: string,
  ) => Promise<User | null>;
  findUserByDriverId: (driverId: string) => Promise<User | null>;
  updateAvatar: (
    userId: string,
    avatarPath: string | null,
  ) => Promise<User | null>;
  createMasterUser: (
    data: CreateMasterUserProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<User>;
  listMasterUsers: (props: ListMasterUsersProps) => Promise<ListUsersPage>;
  searchUserWithCursor: (
    props: SearchUserWithCursorProps,
  ) => Promise<CursorPaginatedUser>;
}

export { IUserRepository };
