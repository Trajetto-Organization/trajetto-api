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
  email: string;
  name: string;
  role: UserRole;
  businessId: string;
  profileAccessId?: string;
  driverId?: string | null;
  whatsapp_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;
  whatsapp_instance_connected?: boolean;
}

interface UpdateUserProps {
  password?: string | null;
  email?: string | null;
  name?: string | null;
  role?: UserRole | null;
  businessId: string;
  profileAccessId?: string | null;
  driverId?: string | null;
  userType?: "employee" | "driver";
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
  email: string;
  email_verified?: Date | null;
  two_factor_enabled?: boolean;
  access_revoked: boolean;
  password: string;
  name: string;
  avatar?: string | null;
  businessId?: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
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
  } | null;
  whatsapp_notifications_enabled?: boolean;
  email_notifications_enabled?: boolean;
  activity_notifications_enabled?: boolean;
  whatsapp_phone?: string | null;
  whatsapp_instance_connected?: boolean;
}

interface UpdateUserPassword {
  userId: string;
  password: string;
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

interface UpdateEmailNotifications {
  userId: string;
  email_notifications_enabled: boolean;
}

interface UpdateActivityNotifications {
  userId: string;
  activity_notifications_enabled: boolean;
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
  email: string;
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

interface ListUsersByRoleAndBusinessProps {
  page: number;
  pageSize: number;
  currentUserRole: UserRole;
  businessId: string;
  currentUserId: string;
  search?: string;
}

interface UpdateUser {
  userData: UpdateUserProps;
  userId: string;
}

interface CreateMasterUserProps {
  name: string;
  email: string;
  password: string;
}

interface UpdateMasterUserProps {
  name?: string | null;
  email?: string | null;
  password?: string | null;
}

interface ListMasterUsersProps {
  page: number;
  pageSize: number;
  search?: string;
  currentUserId?: string;
}

interface SearchUserWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedUser {
  data: User[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  CreateUserProps,
  UpdateUserPassword,
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
  EnumUserRole,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  UpdateEmailNotifications,
  UpdateActivityNotifications,
  CreateMasterUserProps,
  UpdateMasterUserProps,
  ListMasterUsersProps,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
};
