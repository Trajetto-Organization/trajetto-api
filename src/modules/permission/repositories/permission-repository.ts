import { Prisma } from "@prisma/client";

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

import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  PERMISSION_SORT,
  permissionListWhere,
} from "../usecases/list-permission/permission-list";

class PermissionRepository implements IPermissionRepository {
  constructor(private prisma = database) {}

  async createPermission(
    {
      action,
      canRead,
      canWrite,
      businessId,
      profileAccessId,
      permissionKey,
    }: CreatePermissionProps,
    tx?: Prisma.TransactionClient,
  ): Promise<Permission> {
    const createdPermission = await (tx ?? this.prisma).permission.create({
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
    sort,
    order,
    ...filters
  }: ListPermissionProps): Promise<ListPermission> {
    // Two at a time (connection budget): the page ‖ the grouped counts;
    // then the names of the profiles the groups mention.
    const [rows, grouped] = await Promise.all([
      this.prisma.permission.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: permissionListWhere(filters, { withFacets: true }),
        include: { profileAccess: { select: { name: true } } },
        orderBy: resolveOrderBy(PERMISSION_SORT, { sort, order }),
      }),
      this.prisma.permission.groupBy({
        by: ["permissionKey", "profileAccessId", "canRead", "canWrite"],
        where: permissionListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const profileIds = Array.from(
      new Set([
        ...grouped.map((group) => group.profileAccessId),
        ...(filters.profileAccessIds ?? []),
      ]),
    );

    // Only this company's profiles are named: a foreign id in the URL brings
    // back neither a row nor a name.
    const profiles =
      profileIds.length > 0
        ? await this.prisma.profileAccess.findMany({
            where: { id: { in: profileIds }, businessId: filters.businessId },
            select: { id: true, name: true },
          })
        : [];

    return {
      data: rows,
      groups: grouped.map((group) => ({
        permissionKey: group.permissionKey,
        profileAccessId: group.profileAccessId,
        canRead: group.canRead,
        canWrite: group.canWrite,
        count: group._count._all,
      })),
      profileNames: new Map(profiles.map((profile) => [profile.id, profile.name])),
    };
  }

  async updatePermission(
    permissionData: UpdatePermission,
    tx?: Prisma.TransactionClient,
  ): Promise<Permission> {
    const { permissionId, ...dataToUpdate } = permissionData;

    const filteredData = Object.fromEntries(
      Object.entries(dataToUpdate).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    return await (tx ?? this.prisma).permission.update({
      where: { id: permissionId },
      data: filteredData,
    });
  }

  async deletePermission(
    permissionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Permission> {
    const deletePermission = await (tx ?? this.prisma).permission.delete({
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

  async bulkConfigurePermissions(
    { businessId, profileAccessId, permissions }: BulkConfigurePermissionsProps,
    outerTx?: Prisma.TransactionClient,
  ): Promise<void> {
    const replace = async (tx: Prisma.TransactionClient) => {
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
    };

    // The caller's transaction when it has one (the audit entry joins it).
    if (outerTx) {
      await replace(outerTx);
      return;
    }

    await this.prisma.$transaction(replace);
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
