import {
  CreateUserProps,
  User,
  UpdateUserPassword,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  ListUsers,
  UpdateUser,
  ListUsersByRoleAndBusinessProps,
  ListUserBusinessProps,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  UpdateEmailNotifications,
  UpdateActivityNotifications,
} from "../dtos/user-dto";

interface IUserRepository {
  createUser: ({ email, password, name }: CreateUserProps) => Promise<User>;
  listUsers: (
    listUsersProps: ListUsersByRoleAndBusinessProps,
  ) => Promise<ListUsers>;
  listUserBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListUserBusinessProps) => Promise<ListUsers>;
  updateEmailVerification: ({
    email,
    email_verified,
    userId,
  }: UpdateUserEmailVerification) => Promise<User | null>;
  updateUser: ({ userId, userData }: UpdateUser) => Promise<User>;
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
  updateWhatsAppSettings: ({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings) => Promise<User | null>;
  findBusinessAdminsByBusinessId: (businessId: string) => Promise<User[]>;
  findBusinessAdminsForWhatsApp: (businessId: string) => Promise<User[]>;
  updateWhatsAppInstanceStatus: (
    userId: string,
    connected: boolean,
  ) => Promise<User | null>;
  updateEmailNotifications: ({
    userId,
    email_notifications_enabled,
  }: UpdateEmailNotifications) => Promise<User | null>;
  updateActivityNotifications: ({
    userId,
    activity_notifications_enabled,
  }: UpdateActivityNotifications) => Promise<User | null>;
  findUserWithConnectedWhatsAppByPhone: (
    phoneNumber: string,
  ) => Promise<User | null>;
  findUserWithWhatsAppByPhone: (
    phoneNumber: string,
    excludeUserId?: string,
  ) => Promise<User | null>;
  findAllUsersWithDisconnectedWhatsAppByPhone: (
    phoneNumber: string,
    excludeUserId?: string,
  ) => Promise<User[]>;
  findUserByDriverId: (driverId: string) => Promise<User | null>;
  updateAvatar: (
    userId: string,
    avatarPath: string | null,
  ) => Promise<User | null>;
}

export { IUserRepository };
