import {
  CreatePermissionProps,
  FindPermissionKeyByProfile,
  FindPermissionNameByProfile,
  ListPermission,
  ListPermissionProps,
  Permission,
  UpdatePermission,
} from "../dtos/permission-dto";

interface IPermissionRepository {
  createPermission: ({
    action,
    canRead,
    canWrite,
    businessId,
    profileAccessId,
  }: CreatePermissionProps) => Promise<Permission>;
  listPermission: (
    listPermission: ListPermissionProps,
  ) => Promise<ListPermission>;
  updatePermission: (
    updatePermissionsValues: UpdatePermission,
  ) => Promise<Permission>;
  deletePermission: (permissionId: string) => Promise<Permission>;
  findPermissionById: (permissionId: string) => Promise<Permission | null>;
  findPermissionKeyByProfile: (
    findPermissionKey: FindPermissionKeyByProfile,
  ) => Promise<Permission | null>;
  findPermissionNameByProfile: ({
    action,
    profileAccessId,
    businessId,
  }: FindPermissionNameByProfile) => Promise<Permission | null>;
}

export { IPermissionRepository };
