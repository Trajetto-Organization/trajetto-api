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
