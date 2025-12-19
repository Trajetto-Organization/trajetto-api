import database from "@/../infra/database";

import {
  CreatePermissionProps,
  FindPermissionKeyByProfile,
  FindPermissionNameByProfile,
  ListPermission,
  ListPermissionProps,
  Permission,
  UpdatePermission,
} from "../dtos/permission-dto";

import { IPermissionRepository } from "./IPermission-repository";
import { formatDate } from "@/config/format-values";

class PermissionRepository implements IPermissionRepository {
  constructor(private prisma = database) {}

  async createPermission({
    action,
    canRead,
    canWrite,
    businessId,
    profileAccessId,
    permissionKey,
  }: CreatePermissionProps): Promise<Permission> {
    const createdPermission = await this.prisma.permission.create({
      data: {
        action: action,
        permissionKey: permissionKey,
        canRead: canRead,
        canWrite: canWrite,
        businessId: businessId,
        profileAccessId: profileAccessId,
      },
    });

    return createdPermission;
  }

  async listPermission({
    page,
    pageSize,
    businessId,
    currentUserRole,
    profileAccessId,
    search,
  }: ListPermissionProps): Promise<ListPermission> {
    const skip = (page - 1) * pageSize;

    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { action: { contains: normalizedSearch, mode: "insensitive" } },
        { permissionKey: { contains: normalizedSearch, mode: "insensitive" } },
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

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(currentUserRole === "BUSINESS_USER" && {
        profileAccessId: { not: profileAccessId },
      }),
      ...(orConditions.length > 0 ? { OR: orConditions } : {}),
    };

    const permissionData = await this.prisma.permission.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: { select: { corporate_reason: true } },
        profileAccess: { select: { name: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.permission.count({
      where: whereCondition,
    });

    const transformedPermissionData = permissionData.map((permission) => ({
      id: permission.id ?? "N/A",
      action: permission.action ?? "N/A",
      permission: permission.permissionKey ?? "N/A",
      canRead: permission.canRead ?? "N/A",
      canWrite: permission.canWrite ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { corporate_reason: permission.business?.corporate_reason ?? "N/A" }
        : {}),
      profile_name: permission.profileAccess?.name ?? "N/A",
      businessId: permission.businessId ?? "N/A",
      profileAccessId: permission.profileAccessId ?? "N/A",
      created_at: formatDate(permission.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(permission.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformedPermissionData, total };
  }

  async updatePermission(
    permissionData: UpdatePermission,
  ): Promise<Permission> {
    const { permissionId, ...dataToUpdate } = permissionData;

    const filteredData = Object.fromEntries(
      Object.entries(dataToUpdate).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    return await this.prisma.permission.update({
      where: { id: permissionId },
      data: filteredData,
    });
  }

  async deletePermission(permissionId: string): Promise<Permission> {
    const deletePermission = await this.prisma.permission.delete({
      where: {
        id: permissionId,
      },
    });

    return deletePermission;
  }

  async findPermissionNameByProfile({
    action,
    profileAccessId,
    businessId,
  }: FindPermissionNameByProfile): Promise<Permission | null> {
    const findPermissionNameByProfile = await this.prisma.permission.findFirst({
      where: {
        action: action,
        profileAccessId: profileAccessId,
        businessId: businessId,
      },
    });

    return findPermissionNameByProfile;
  }

  async findPermissionKeyByProfile({
    permissionKey,
    profileAccessId,
    businessId,
  }: FindPermissionKeyByProfile): Promise<Permission | null> {
    return await this.prisma.permission.findFirst({
      where: {
        permissionKey,
        profileAccessId,
        businessId,
      },
    });
  }

  async findPermissionById(permissionId: string): Promise<Permission | null> {
    const findPermissionById = await this.prisma.permission.findUnique({
      where: {
        id: permissionId,
      },
    });

    return findPermissionById;
  }
}

export { PermissionRepository };
