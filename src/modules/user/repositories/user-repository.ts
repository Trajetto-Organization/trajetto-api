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
  ListUserBusinessProps,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  UpdateEmailNotifications,
  UpdateActivityNotifications,
} from "../dtos/user-dto";

import { formatDate } from "@/config/format-values";

class UserRepository implements IUserRepository {
  constructor(private prisma = database) {}

  async createUser({
    email,
    password,
    name,
    role,
    profileAccessId,
    businessId,
  }: CreateUserProps): Promise<User> {
    if (role === "MASTER") {
      throw new Error("Cannot create MASTER users through this method. Use dedicated MASTER creation method instead.");
    }

    const userCreated = await this.prisma.user.create({
      data: {
        email,
        password: password as string,
        name,
        role,
        businessId,
        profileAccessId: role === "BUSINESS_ADMIN" ? null : profileAccessId,
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

    const usersAccessData = await this.prisma.user.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: {
          select: { corporate_reason: true },
        },
        profileAccess: {
          select: { name: true },
        },
      },
    });

    const total = await this.prisma.user.count({
      where: whereCondition,
    });

    const transformeUserAccessData = usersAccessData.map((user) => ({
      id: user.id ?? "N/A",
      name: user.name ?? "N/A",
      email: user.email ?? "N/A",
      avatar: user.avatar ?? "N/A",
      role: user.role ?? "N/A",
      two_factor_enabled: user.two_factor_enabled ?? "N/A",
      access_revoked: user.access_revoked ?? "N/A",
      email_verified: user.email_verified ? true : false,
      whatsapp_phone: user.whatsapp_phone ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { corporate_reason: user.business?.corporate_reason ?? "N/A" }
        : {}),
      businessId: user.businessId ?? "N/A",
      profileAccess: user.profileAccess?.name ?? "N/A",
      profileAccessId: user.profileAccessId ?? "N/A",
      created_at: formatDate(user.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(user.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformeUserAccessData, total };
  }

  async listUserBusiness({
    page,
    pageSize,
    businessId,
  }: ListUserBusinessProps): Promise<ListUsers> {
    const skip = (page - 1) * pageSize;

    const userBusinessData = await this.prisma.user.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.user.count({
      where: {
        businessId,
      },
    });

    return { data: userBusinessData, total };
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
    const filteredData = Object.fromEntries(
      Object.entries(userData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    if (filteredData.role === "BUSINESS_ADMIN") {
      filteredData.profileAccessId = null;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: filteredData,
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
      data: { password },
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
      data: { access_revoked: isAccessRevoke },
    });

    return updateUserAccessRevocation;
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
          },
        },
      },
      orderBy: {
        created_at: "asc",
      },
    });

    return admins;
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
}

export { UserRepository };
