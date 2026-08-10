import database from "@/../infra/database";
import { IUserRepository } from "./IUser-repository";

import {
  CreateUserProps,
  User,
  UpdateUserPassword,
  UpdateUserName,
  UpdateTwoFactorAuthentication,
  ListUsers,
  UpdateUser,
  UserRole,
  ListUsersByRoleAndBusinessProps,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  UpdateEmailNotifications,
  UpdateActivityNotifications,
  CreateMasterUserProps,
  ListMasterUsersProps,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
} from "../dtos/user-dto";

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
    businessId,
    currentUserId,
    currentUserRole,
    search,
  }: ListUsersByRoleAndBusinessProps): Promise<ListUsers> {
    const skip = (page - 1) * pageSize;

    const rolePermissions: Record<UserRole, UserRole[]> = {
      MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN"],
      BUSINESS_ADMIN: ["BUSINESS_ADMIN", "BUSINESS_USER"],
      BUSINESS_USER: ["BUSINESS_USER"],
    };

    // Role mapping: keys are in lowercase to facilitate partial search
    const roleMap: Record<string, string> = {
      administrador: "BUSINESS_ADMIN",
      usuário: "BUSINESS_USER",
    };

    // Normalizes the search term (if any)
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    let roleSearch: string | null = null;

    if (normalizedSearch) {
      for (const [label, roleValue] of Object.entries(roleMap)) {
        if (label.includes(normalizedSearch)) {
          roleSearch = roleValue;
          break;
        }
      }
    }

    const allowedRoles = rolePermissions[currentUserRole];

    // Builds an array of conditions for the OR filter
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        {
          profileAccessId: { contains: normalizedSearch, mode: "insensitive" },
        },
        {
          driverId: { contains: normalizedSearch, mode: "insensitive" },
        },
        {
          ...(currentUserRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
        {
          ...(currentUserRole === "MASTER"
            ? {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              }
            : {}),
        },
        {
          profileAccess: {
            name: { contains: normalizedSearch, mode: "insensitive" },
          },
        },
      );
    }

    if (roleSearch) {
      orConditions.push({ role: roleSearch });
    }

    const whereCondition = {
      role: { in: allowedRoles },
      ...(currentUserRole !== "MASTER" && { businessId }),
      id: { not: currentUserId },
      ...(orConditions.length > 0 ? { OR: orConditions } : {}),
    };

    const [usersAccessData, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          }),
          profileAccess: {
            select: { name: true },
          },
          driver: {
            select: { name: true },
          },
        },
        orderBy: {
          created_at: "desc", // Sort by created_at
        },
      }),
      this.prisma.user.count({
        where: whereCondition,
      }),
    ]);

    return { data: usersAccessData, total };
  }

  async updateEmailVerification({
    userId,
    email,
    email_verified,
  }: UpdateUserEmailVerification): Promise<User | null> {
    const updatedEmailVerification = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email_verified,
        email,
      },
    });

    return updatedEmailVerification;
  }

  async updateUser({ userId, userData }: UpdateUser): Promise<User> {
    // Extract relation fields that need Prisma-specific translation
    const {
      businessId,
      profileAccessId,
      driverId,
      userType,
      password,
      ...restData
    } = userData;

    // Build Prisma update data from direct fields (excluding undefined values)
    const updateData: any = {};

    Object.entries(restData).forEach(([key, value]) => {
      if (value !== undefined) {
        updateData[key] = value;
      }
    });

    // Password: only include if provided by use case
    if (password) {
      updateData.password = password;
      updateData.session_version = { increment: 1 };
      updateData.RefreshToken = { deleteMany: {} };
    }

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

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return updatedUser;
  }

  async deleteUser(userId: string): Promise<User> {
    const deletedUser = await this.prisma.user.delete({
      where: { id: userId },
    });

    return deletedUser;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const findUserByEmail = await this.prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
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
        email: {
          equals: email,
          mode: "insensitive",
        },
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

  async findUserById(userId: string): Promise<User | null> {
    const findUserById = await this.prisma.user.findUnique({
      where: {
        id: userId,
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
        driver: {
          select: {
            id: true,
            status: true,
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

  async updateUserPassword({
    userId,
    password,
  }: UpdateUserPassword): Promise<User | null> {
    const updatedUserPassword = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password,
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
      },
    });

    return updatedUserPassword;
  }

  async updateUserName({ userId, name }: UpdateUserName): Promise<User | null> {
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
    const updatedTwoFactorAuthentication = await this.prisma.user.update({
      where: { id: userId },
      data: { two_factor_enabled: isTwoFactorEnabled },
    });

    return updatedTwoFactorAuthentication;
  }

  async updateUserAccessRevocation({
    userId,
    isAccessRevoke,
  }: UpdateUserAccessRevocation): Promise<User | null> {
    const updateUserAccessRevocation = await this.prisma.user.update({
      where: { id: userId },
      data: {
        access_revoked: isAccessRevoke,
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
      },
    });

    return updateUserAccessRevocation;
  }

  async invalidateUserSessions(userId: string): Promise<User | null> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        session_version: { increment: 1 },
        RefreshToken: { deleteMany: {} },
      },
    });
  }

  async updateWhatsAppSettings({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings): Promise<User | null> {
    const updatedWhatsAppSettings = await this.prisma.user.update({
      where: { id: userId },
      data: {
        whatsapp_notifications_enabled: whatsapp_notifications_enabled,
        whatsapp_phone: whatsapp_phone || null,
        // If disabling, also mark as disconnected
        ...(whatsapp_notifications_enabled === false && {
          whatsapp_instance_connected: false,
        }),
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

  async findBusinessAdminsForWhatsApp(businessId: string): Promise<User[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        businessId,
        role: "BUSINESS_ADMIN",
        access_revoked: false,
        whatsapp_notifications_enabled: true,
        whatsapp_phone: {
          not: null,
        },
      },
      include: {
        business: {
          select: {
            corporate_reason: true,
            is_active: true,
          },
        },
      },
    });

    return admins;
  }

  async findUsersWithWhatsAppEnabled(businessId: string): Promise<User[]> {
    const users = await this.prisma.user.findMany({
      where: {
        businessId,
        whatsapp_notifications_enabled: true,
        whatsapp_phone: {
          not: null,
        },
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
        name: "asc",
      },
    });

    return users;
  }

  async updateWhatsAppInstanceStatus(
    userId: string,
    connected: boolean,
  ): Promise<User | null> {
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        whatsapp_instance_connected: connected,
      },
    });

    return updatedUser;
  }

  async updateEmailNotifications({
    userId,
    email_notifications_enabled,
  }: UpdateEmailNotifications): Promise<User | null> {
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email_notifications_enabled,
      },
    });

    return updatedUser;
  }

  async updateActivityNotifications({
    userId,
    activity_notifications_enabled,
  }: UpdateActivityNotifications): Promise<User | null> {
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        activity_notifications_enabled,
      },
    });

    return updatedUser;
  }

  async findUserWithConnectedWhatsAppByPhone(
    phoneNumber: string,
  ): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        whatsapp_phone: phoneNumber,
        whatsapp_notifications_enabled: true,
        whatsapp_instance_connected: true,
        access_revoked: false,
      },
    });

    return user;
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

  async findAllUsersWithDisconnectedWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User[]> {
    const users = await this.prisma.user.findMany({
      where: {
        whatsapp_phone: phoneNumber,
        whatsapp_notifications_enabled: true,
        whatsapp_instance_connected: false,
        access_revoked: false,
        ...(excludeUserId && { id: { not: excludeUserId } }),
      },
    });

    return users;
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
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: avatarPath },
    });

    return updatedUser;
  }

  async createMasterUser({
    name,
    email,
    password,
  }: CreateMasterUserProps): Promise<User> {
    const masterUser = await this.prisma.user.create({
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
    search,
    currentUserId,
  }: ListMasterUsersProps): Promise<ListUsers> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const whereCondition: any = {
      role: "MASTER",
      ...(currentUserId ? { id: { not: currentUserId } } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { id: { contains: normalizedSearch, mode: "insensitive" } },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { email: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.user.count({ where: whereCondition }),
    ]);

    return { data, total };
  }

  async searchUserWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchUserWithCursorProps): Promise<CursorPaginatedUser> {
    const items = await this.prisma.user.findMany({
      where: { businessId },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { created_at: "desc" },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { UserRepository };
