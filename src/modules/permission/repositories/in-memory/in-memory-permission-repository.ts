import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { IPermissionRepository } from "../IPermission-repository";

import {
  CreatePermissionProps,
  Permission,
  ListPermission,
  UpdatePermission,
  FindPermissionNameByProfile,
  ListPermissionProps,
  FindPermissionKeyByProfile,
  BulkConfigurePermissionsProps,
  PermissionListRow,
} from "../../dtos/permission-dto";

import { permissionLabels, PermissionKey } from "@/config/permissions";

import {
  PERMISSION_SORT_FALLBACK,
  keysLabelled,
  type PermissionGroupCount,
  type PermissionSortKey,
} from "../../usecases/list-permission/permission-list";

import type { SortOrder } from "@/shared/pagination/list-query";
import { compareForOrder } from "@/shared/pagination/in-memory-order";

type StoredPermission = Permission & { created_at?: Date; updated_at?: Date };

function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "An operation failed because it depends on one or more records that were required but not found.",
    { code: "P2025", clientVersion: "in-memory" },
  );
}

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    { code: "P2002", clientVersion: "in-memory", meta: { target: [target] } },
  );
}

const time = (value: Date | undefined) => (value ? new Date(value).getTime() : 0);

/**
 * The Prisma repository's twin: tenant filter, the same facets, search and
 * order, P2025 on a missing row. The old listing showed a BUSINESS_USER ONLY
 * their own profile's permissions, where Postgres shows every profile BUT
 * theirs — a unit test could pass on the opposite rule.
 */
class InMemoryPermissionRepository implements IPermissionRepository {
  public permissions: StoredPermission[] = [];

  /** Profile names by id (the real query reads the relation). */
  public profiles = new Map<string, { name: string; businessId: string }>();

  async createPermission({
    action,
    canRead,
    canWrite,
    businessId,
    profileAccessId,
    permissionKey,
  }: CreatePermissionProps): Promise<Permission> {
    // @@unique([action, profileAccessId, businessId]), as Postgres raises it.
    if (this.collides({ action, profileAccessId, businessId })) {
      throw uniqueViolation("action");
    }

    const now = new Date();
    const newPermission: StoredPermission = {
      id: uuidV7(),
      action,
      canRead,
      canWrite,
      businessId,
      profileAccessId,
      permissionKey,
      created_at: now,
      updated_at: now,
    };

    this.permissions.push(newPermission);
    return newPermission;
  }

  /** Another row already holds this (action, profile, company) slot. */
  private collides(
    row: Pick<Permission, "action" | "profileAccessId" | "businessId">,
    exceptId?: string,
  ): boolean {
    return this.permissions.some(
      (perm) =>
        perm.id !== exceptId &&
        perm.action === row.action &&
        perm.profileAccessId === row.profileAccessId &&
        perm.businessId === row.businessId,
    );
  }

  private profileName(permission: StoredPermission): string {
    return this.profiles.get(permission.profileAccessId)?.name ?? "";
  }

  private sortValue(
    permission: StoredPermission,
    key: PermissionSortKey,
  ): string | number | boolean {
    switch (key) {
      case "created_at":
        return time(permission.created_at);
      case "updated_at":
        return time(permission.updated_at);
      case "action":
        return permission.action;
      case "permissionKey":
        return permission.permissionKey ?? "";
      case "profile_name":
        return this.profileName(permission);
      case "canRead":
        return permission.canRead;
      case "canWrite":
        return permission.canWrite;
    }
  }

  async listPermission({
    page,
    pageSize,
    sort,
    order,
    businessId,
    search,
    hideProfileId,
    permissionKeys,
    profileAccessIds,
    read,
    write,
  }: ListPermissionProps): Promise<ListPermission> {
    const term = search?.trim().toLocaleLowerCase("pt-BR") ?? "";
    const labelledKeys = term ? (keysLabelled(term) as string[]) : [];

    const base = this.permissions.filter(
      (permission) =>
        permission.businessId === businessId &&
        (!hideProfileId || permission.profileAccessId !== hideProfileId) &&
        (!term ||
          permission.id.toLowerCase().includes(term) ||
          permission.action.toLocaleLowerCase("pt-BR").includes(term) ||
          this.profileName(permission).toLocaleLowerCase("pt-BR").includes(term) ||
          labelledKeys.includes(permission.permissionKey ?? "")),
    );

    const filtered = base.filter(
      (permission) =>
        (!permissionKeys?.length ||
          (permissionKeys as string[]).includes(permission.permissionKey ?? "")) &&
        (!profileAccessIds?.length ||
          profileAccessIds.includes(permission.profileAccessId)) &&
        (read?.length !== 1 || permission.canRead === (read[0] === "enabled")) &&
        (write?.length !== 1 || permission.canWrite === (write[0] === "enabled")),
    );

    const key = sort ?? PERMISSION_SORT_FALLBACK.sort;
    const direction: SortOrder = order ?? (sort ? "asc" : PERMISSION_SORT_FALLBACK.order);

    // The comparator every twin shares (table-infra contract): false before
    // true, code-point strings, and Postgres's created_at desc, id desc
    // tiebreaker.
    const sorted = [...filtered].sort(
      (a, b) =>
        compareForOrder(this.sortValue(a, key), this.sortValue(b, key), direction) ||
        compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
        compareForOrder(a.id, b.id, "desc"),
    );

    const groups = new Map<string, PermissionGroupCount>();

    for (const permission of base) {
      const groupKey = [
        permission.permissionKey,
        permission.profileAccessId,
        permission.canRead,
        permission.canWrite,
      ].join("|");

      const group = groups.get(groupKey);

      if (group) {
        group.count += 1;
      } else {
        groups.set(groupKey, {
          permissionKey: permission.permissionKey ?? "",
          profileAccessId: permission.profileAccessId,
          canRead: permission.canRead,
          canWrite: permission.canWrite,
          count: 1,
        });
      }
    }

    const profileNames = new Map<string, string>();

    for (const id of new Set([
      ...base.map((permission) => permission.profileAccessId),
      ...(profileAccessIds ?? []),
    ])) {
      const profile = this.profiles.get(id);
      if (profile && profile.businessId === businessId) profileNames.set(id, profile.name);
    }

    const skip = (page - 1) * pageSize;

    return {
      data: sorted.slice(skip, skip + pageSize).map(
        (permission) =>
          ({
            ...permission,
            created_at: permission.created_at ?? new Date(0),
            updated_at: permission.updated_at ?? new Date(0),
            profileAccess: { name: this.profileName(permission) },
          }) as PermissionListRow,
      ),
      groups: Array.from(groups.values()),
      profileNames,
    };
  }

  async updatePermission({
    permissionId,
    ...updateValues
  }: UpdatePermission): Promise<Permission> {
    const index = this.permissions.findIndex(
      (perm) => perm.id === permissionId,
    );

    if (index === -1) throw recordNotFound();

    // As the real one: undefined, null and "" leave the column alone.
    const changes = Object.fromEntries(
      Object.entries(updateValues).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const next = {
      ...this.permissions[index],
      ...changes,
      updated_at: new Date(),
    } as StoredPermission;

    // @@unique([action, profileAccessId, businessId]) holds on update too:
    // renaming or moving onto another row's slot is refused by Postgres.
    if (this.collides(next, permissionId)) throw uniqueViolation("action");

    this.permissions[index] = next;

    return next;
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

    if (index === -1) throw recordNotFound();

    const [deletedPermission] = this.permissions.splice(index, 1);
    return deletedPermission;
  }

  async findPermissionById(permissionId: string): Promise<Permission | null> {
    return this.permissions.find((perm) => perm.id === permissionId) ?? null;
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

    return found ?? null;
  }

  async bulkConfigurePermissions({
    businessId,
    profileAccessId,
    permissions,
  }: BulkConfigurePermissionsProps): Promise<void> {
    // createMany hits the same unique index: one repeated key and the whole
    // replacement rolls back, the old set untouched.
    const labels = permissions.map(
      ({ permissionKey }) => permissionLabels[permissionKey as PermissionKey],
    );

    if (new Set(labels).size !== labels.length) throw uniqueViolation("action");

    this.permissions = this.permissions.filter(
      (perm) =>
        !(
          perm.profileAccessId === profileAccessId &&
          perm.businessId === businessId
        ),
    );

    const now = new Date();

    for (const { permissionKey, canRead, canWrite } of permissions) {
      this.permissions.push({
        id: uuidV7(),
        action: permissionLabels[permissionKey as PermissionKey],
        permissionKey,
        canRead,
        canWrite,
        businessId,
        profileAccessId,
        created_at: now,
        updated_at: now,
      });
    }
  }

  async findPermissionsByProfile(
    profileAccessId: string,
    businessId: string,
  ): Promise<Permission[]> {
    return this.permissions
      .filter(
        (perm) =>
          perm.profileAccessId === profileAccessId &&
          perm.businessId === businessId,
      )
      .sort((a, b) => compareForOrder(a.permissionKey, b.permissionKey, "asc"));
  }
}

export { InMemoryPermissionRepository };
