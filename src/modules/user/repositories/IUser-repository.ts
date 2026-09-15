import { Prisma } from "@prisma/client";

import {
  CreateUserProps,
  User,
  UpdateUserPassword,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  ListUsers,
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
  ) => Promise<ListUsers>;
  updateEmailVerification: ({
    email,
    email_verified,
    userId,
  }: UpdateUserEmailVerification) => Promise<User | null>;
  updateUser: (
    update: UpdateUser,
    tx?: Prisma.TransactionClient,
  ) => Promise<User>;
  deleteUser: (userId: string) => Promise<User>;

  /**
   * Apaga um MASTER, mas nunca o último.
   *
   * Devolve `null` quando a exclusão deixaria a plataforma sem nenhum, ou
   * quando o alvo não é um MASTER. Contar antes e apagar depois não serve:
   * dois pedidos simultâneos apagando MASTERs diferentes leem o mesmo total,
   * os dois passam, e sobram zero — e MASTER é o único papel que cria outro.
   */
  deleteMasterUserKeepingOne: (userId: string) => Promise<User | null>;
  findUserByEmail: (email: string) => Promise<User | null>;
  findUserByEmailAndBusinessId: (
    email: string,
    businessId: string,
  ) => Promise<User | null>;
  findUserById: (userId: string) => Promise<User | null>;
  findUsersByBusiness: (businessId: string) => Promise<User[]>;
  updateUserPassword: ({
    userId,
    password,
  }: UpdateUserPassword) => Promise<User | null>;
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
  updateWhatsAppSettings: ({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings) => Promise<User | null>;
  findBusinessAdminsByBusinessId: (businessId: string) => Promise<User[]>;
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
  listMasterUsers: (props: ListMasterUsersProps) => Promise<ListUsers>;
  searchUserWithCursor: (
    props: SearchUserWithCursorProps,
  ) => Promise<CursorPaginatedUser>;
}

export { IUserRepository };
