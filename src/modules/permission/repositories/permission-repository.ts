import database from "@/../infra/database";

import {
  BulkConfigurePermissionsProps,
  CreatePermissionProps,
  FindPermissionKeyByProfile,
  FindPermissionNameByProfile,
  ListPermission,
  ListPermissionProps,
  Permission,
  UpdatePermission,
} from "../dtos/permission-dto";

import { IPermissionRepository } from "./IPermission-repository";
import { permissionLabels, PermissionKey } from "@/config/permissions";

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
      // Find permission keys that match the search by label
      const matchingPermissionKeys: PermissionKey[] = [];

      Object.entries(permissionLabels).forEach(([key, label]) => {
        if (label.toLowerCase().includes(normalizedSearch)) {
          matchingPermissionKeys.push(key as PermissionKey);
        }
      });

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { action: { contains: normalizedSearch, mode: "insensitive" } },
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

      // Add conditions for matching permission keys by label
      if (matchingPermissionKeys.length > 0) {
        orConditions.push({
          permissionKey: { in: matchingPermissionKeys },
        });
      }
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(currentUserRole === "BUSINESS_USER" && {
        profileAccessId: { not: profileAccessId },
      }),
      ...(orConditions.length > 0 ? { OR: orConditions } : {}),
    };

    const [permissionData, total] = await Promise.all([
      this.prisma.permission.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                id: true,
                corporate_reason: true,
              },
            },
          }),
          profileAccess: { select: { name: true } },
        },
        orderBy: {
          created_at: "desc", // Sort by created_at
        },
      }),
      this.prisma.permission.count({
        where: whereCondition,
      }),
    ]);

    return { data: permissionData, total };
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

  async bulkConfigurePermissions({
    businessId,
    profileAccessId,
    permissions,
  }: BulkConfigurePermissionsProps): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.permission.deleteMany({
        where: { profileAccessId, businessId },
      });

      if (permissions.length > 0) {
        await tx.permission.createMany({
          data: permissions.map(({ permissionKey, canRead, canWrite }) => ({
            action: permissionLabels[permissionKey as PermissionKey],
            permissionKey,
            canRead,
            canWrite,
            businessId,
            profileAccessId,
          })),
        });
      }
    });
  }

  async findPermissionsByProfile(
    profileAccessId: string,
    businessId: string,
  ): Promise<Permission[]> {
    return await this.prisma.permission.findMany({
      where: { profileAccessId, businessId },
      orderBy: { permissionKey: "asc" },
    });
  }
}

export { PermissionRepository };
