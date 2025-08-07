import { v4 as uuidV4 } from "uuid";

import { IPermissionRepository } from "../IPermission-repository";
import {
  CreatePermissionProps,
  Permission,
  ListPermission,
  UpdatePermission,
  FindPermissionNameByProfile,
  ListPermissionProps,
  FindPermissionKeyByProfile,
} from "../../dtos/permission-dto";

class InMemoryPermissionRepository implements IPermissionRepository {
  public permissions: Permission[] = [];

  async createPermission({
    action,
    canRead,
    canWrite,
    businessId,
    profileAccessId,
    permissionKey,
  }: CreatePermissionProps): Promise<Permission> {
    const newPermission: Permission = {
      id: uuidV4(),
      action,
      canRead,
      canWrite,
      businessId,
      profileAccessId,
      permissionKey,
    };

    this.permissions.push(newPermission);
    return newPermission;
  }

  async listPermission({
    page,
    pageSize,
  }: ListPermissionProps): Promise<ListPermission> {
    const skip = (page - 1) * pageSize;
    const paginatedPermissions = this.permissions.slice(skip, skip + pageSize);

    return {
      data: paginatedPermissions,
      total: this.permissions.length,
    };
  }

  async updatePermission({
    permissionId,
    ...updateValues
  }: UpdatePermission): Promise<Permission> {
    const index = this.permissions.findIndex(
      (perm) => perm.id === permissionId,
    );

    this.permissions[index] = {
      ...this.permissions[index],
      ...updateValues,
      updated_at: new Date(),
    } as Permission;

    return this.permissions[index];
  }

  async findPermissionKeyByProfile({
    permissionKey,
    profileAccessId,
    businessId,
  }: FindPermissionKeyByProfile): Promise<Permission | null> {
    const found = this.permissions.find(
      (perm) =>
        perm.permissionKey === permissionKey &&
        perm.profileAccessId === profileAccessId &&
        perm.businessId === businessId,
    );

    return found || null;
  }

  async deletePermission(permissionId: string): Promise<Permission> {
    const index = this.permissions.findIndex(
      (perm) => perm.id === permissionId,
    );

    const [deletedPermission] = this.permissions.splice(index, 1);
    return deletedPermission;
  }

  async findPermissionById(permissionId: string): Promise<Permission | null> {
    const found = this.permissions.find((perm) => perm.id === permissionId);

    if (!found) {
      return null;
    }

    return found;
  }

  async findPermissionNameByProfile({
    action,
    profileAccessId,
    businessId,
  }: FindPermissionNameByProfile): Promise<Permission | null> {
    const found = this.permissions.find(
      (perm) =>
        perm.action === action &&
        perm.profileAccessId === profileAccessId &&
        perm.businessId === businessId,
    );

    if (!found) {
      return null;
    }

    return found;
  }
}

export { InMemoryPermissionRepository };
