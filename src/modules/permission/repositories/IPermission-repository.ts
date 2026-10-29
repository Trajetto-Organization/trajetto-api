import { Prisma } from "@prisma/client";

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

/**
 * The writes take an optional `tx`: a permission change and its audit entry
 * commit together (OUTBOX-10).
 */
interface IPermissionRepository {
  createPermission: (
    {
      action,
      canRead,
      canWrite,
      businessId,
      profileAccessId,
    }: CreatePermissionProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Permission>;
  listPermission: (
    listPermission: ListPermissionProps,
  ) => Promise<ListPermission>;
  updatePermission: (
    updatePermissionsValues: UpdatePermission,
    tx?: Prisma.TransactionClient,
  ) => Promise<Permission>;
  deletePermission: (
    permissionId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<Permission>;
  findPermissionById: (permissionId: string) => Promise<Permission | null>;
  findPermissionKeyByProfile: (
    findPermissionKey: FindPermissionKeyByProfile,
  ) => Promise<Permission | null>;
  findPermissionNameByProfile: ({
    action,
    profileAccessId,
    businessId,
  }: FindPermissionNameByProfile) => Promise<Permission | null>;
  bulkConfigurePermissions: (
    props: BulkConfigurePermissionsProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
  findPermissionsByProfile: (
    profileAccessId: string,
    businessId: string,
  ) => Promise<Permission[]>;
}

export { IPermissionRepository };
