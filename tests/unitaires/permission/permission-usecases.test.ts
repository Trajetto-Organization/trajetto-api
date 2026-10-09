import { beforeEach, describe, expect, it, vi } from "vitest";

const realtime = vi.hoisted(() => ({
  sendSecurityEventToBusiness: vi.fn(),
  sendCatalogChangedEvent: vi.fn(),
}));

// The socket server is not up in unit tests; what matters is that the
// security event goes out for the right company, and only after a commit.
vi.mock("@/websocket", () => realtime);

const tx = vi.hoisted(() => ({
  current: { $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}) },
}));

vi.mock("@/../infra/database", () => ({
  default: { $transaction: (run: (client: unknown) => Promise<unknown>) => tx.current.$transaction(run) },
}));

import { CreatePermissionUseCase } from "@/modules/permission/usecases/create-permission/create-permission-usecase";
import { UpdatePermissionUseCase } from "@/modules/permission/usecases/update-permission/update-permission-usecase";
import { ListPermissionUseCase } from "@/modules/permission/usecases/list-permission/list-permission-usecase";
import { ListPermissionsByProfileUseCase } from "@/modules/permission/usecases/list-permissions-by-profile/list-permissions-by-profile-usecase";

import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { inMemoryTransaction } from "@/shared/in-memory/in-memory-transaction";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { PermissionKey } from "@/config/permissions";

/**
 * The permission writes and reads on the twins: a grant needs a real company
 * and a profile of that company, never duplicates a resource or a label, a
 * BUSINESS_USER never touches their own profile, an edit is checked against
 * the permission's CURRENT tenant, the grant and its audit entry commit or
 * roll back together, and only a committed change tells the company's
 * sessions to refresh (sendSecurityEventToBusiness).
 */
const COMPANY = "018f0000-0000-7000-8000-00000000000a";
const OTHER_COMPANY = "018f0000-0000-7000-8000-00000000000b";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const OPERATOR = "018f0000-0000-7000-8000-0000000000a2";
const FOREIGN_ADMIN = "018f0000-0000-7000-8000-0000000000a3";
const MASTER = "018f0000-0000-7000-8000-0000000000a4";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";
const PROFILE = "018f0000-0000-7000-8000-0000000000c1";
const OWN_PROFILE = "018f0000-0000-7000-8000-0000000000c2";
const FOREIGN_PROFILE = "018f0000-0000-7000-8000-0000000000c3";

const grant = (permissionKey: PermissionKey, action: string, profileAccessId = PROFILE, businessId = COMPANY) => ({
  permissionKey,
  action,
  profileAccessId,
  businessId,
  canRead: true,
  canWrite: false,
});

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const profiles = new InMemoryProfileAccessRepository();
  const permissions = new InMemoryPermissionRepository();
  const audit: unknown[] = [];

  const activities = {
    createActivityIfEnabled: vi.fn(async (entry: unknown) => {
      audit.push(entry);
    }),
  };

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: COMPANY, profileAccessId: null, profileAccess: null } as unknown as User,
    {
      id: OPERATOR,
      role: "BUSINESS_USER",
      businessId: COMPANY,
      profileAccessId: OWN_PROFILE,
      profileAccess: { name: "Operação", permissions: [] },
    } as unknown as User,
    {
      id: FOREIGN_ADMIN,
      role: "BUSINESS_ADMIN",
      businessId: OTHER_COMPANY,
      profileAccessId: null,
      profileAccess: null,
    } as unknown as User,
    { id: MASTER, role: "MASTER", businessId: null, profileAccessId: null, profileAccess: null } as unknown as User,
  );
  businesses.business.push(
    { ...BUSINESS_COLUMN_DEFAULTS, id: COMPANY } as unknown as Business,
    { ...BUSINESS_COLUMN_DEFAULTS, id: OTHER_COMPANY } as unknown as Business,
  );
  profiles.profileAccess.push(
    { id: PROFILE, name: "Financeiro", businessId: COMPANY },
    { id: OWN_PROFILE, name: "Operação", businessId: COMPANY },
    { id: FOREIGN_PROFILE, name: "Financeiro", businessId: OTHER_COMPANY },
  );
  permissions.profiles.set(PROFILE, { name: "Financeiro", businessId: COMPANY });
  permissions.profiles.set(OWN_PROFILE, { name: "Operação", businessId: COMPANY });
  permissions.profiles.set(FOREIGN_PROFILE, { name: "Financeiro", businessId: OTHER_COMPANY });

  const transaction = inMemoryTransaction([permissions, audit]);
  tx.current = transaction;

  const service = activities as unknown as NotificationService;

  return {
    users,
    permissions,
    audit,
    activities,
    transaction,
    create: new CreatePermissionUseCase(users, permissions, businesses, profiles, service),
    update: new UpdatePermissionUseCase(users, permissions, businesses, profiles, service),
    list: new ListPermissionUseCase(users, permissions, businesses),
    byProfile: new ListPermissionsByProfileUseCase(users, permissions),
  };
}

beforeEach(() => {
  realtime.sendSecurityEventToBusiness.mockClear();
});

describe("creating a permission", () => {
  it("grants, audits and tells the company's sessions to refresh", async () => {
    const context = makeContext();

    const created = await context.create.execute(grant("kanban_manage", "Gerenciar Kanban"), ADMIN);

    expect(context.permissions.permissions).toEqual([expect.objectContaining({ id: created.id, profileAccessId: PROFILE })]);
    expect(context.audit).toEqual([expect.objectContaining({ action: "create", entityId: created.id, businessId: COMPANY })]);
    expect(realtime.sendSecurityEventToBusiness).toHaveBeenCalledWith(COMPANY, { reason: "permissions_changed" });
  });

  it("refuses a duplicate label and a resource already assigned to the profile with 409", async () => {
    const context = makeContext();

    await context.create.execute(grant("kanban_manage", "Gerenciar Kanban"), ADMIN);

    await expect(
      context.create.execute(grant("supplier_manage", "Gerenciar Kanban"), ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PERMISSION_ALREADY_EXISTS" });
    await expect(
      context.create.execute(grant("kanban_manage", "Outro rótulo"), ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PERMISSION_ALREADY_ASSIGNED" });
    expect(context.permissions.permissions).toHaveLength(1);
  });

  it("refuses a BUSINESS_USER granting to their own profile with PERMISSION_DENIED", async () => {
    const context = makeContext();

    await expect(
      context.create.execute(grant("kanban_manage", "Gerenciar Kanban", OWN_PROFILE), OPERATOR),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(context.permissions.permissions).toHaveLength(0);
  });

  it("refuses another company's profile as a profile that does not exist", async () => {
    const context = makeContext();

    await expect(
      context.create.execute(grant("kanban_manage", "Gerenciar Kanban", FOREIGN_PROFILE), ADMIN),
    ).rejects.toMatchObject({ code: "PROFILE_ACCESS_NOT_FOUND" });
    expect(context.permissions.permissions).toHaveLength(0);
  });

  it("refuses an unknown user, company or profile with 404", async () => {
    const context = makeContext();

    await expect(context.create.execute(grant("kanban_manage", "K"), GHOST)).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    await expect(
      context.create.execute(grant("kanban_manage", "K", PROFILE, GHOST), ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
    await expect(context.create.execute(grant("kanban_manage", "K", GHOST), ADMIN)).rejects.toMatchObject({
      code: "PROFILE_ACCESS_NOT_FOUND",
    });
  });

  it("rolls the grant back when its audit entry fails, and announces nothing", async () => {
    const context = makeContext();
    context.activities.createActivityIfEnabled.mockRejectedValueOnce(new Error("audit down"));

    await expect(
      context.create.execute(grant("kanban_manage", "Gerenciar Kanban"), ADMIN),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(context.permissions.permissions).toHaveLength(0);
    expect(context.transaction.stats.rolledBack).toBe(1);
    expect(realtime.sendSecurityEventToBusiness).not.toHaveBeenCalled();
  });
});

describe("updating a permission", () => {
  async function seeded() {
    const context = makeContext();
    const kanban = await context.create.execute(grant("kanban_manage", "Gerenciar Kanban"), ADMIN);
    const supplier = await context.create.execute(grant("supplier_manage", "Gerenciar Fornecedores"), ADMIN);
    const foreign = await context.create.execute(
      grant("kanban_manage", "Gerenciar Kanban", FOREIGN_PROFILE, OTHER_COMPANY),
      FOREIGN_ADMIN,
    );

    realtime.sendSecurityEventToBusiness.mockClear();
    context.audit.length = 0;

    return { context, kanban, supplier, foreign };
  }

  const edit = (permissionId: string, changes: Partial<ReturnType<typeof grant>> = {}) => ({
    permissionId,
    ...grant("kanban_manage", "Gerenciar Kanban"),
    ...changes,
  });

  it("changes the flags, audits and announces", async () => {
    const { context, kanban } = await seeded();

    const updated = await context.update.execute(edit(kanban.id, { canWrite: true }), ADMIN);

    expect(updated).toMatchObject({ id: kanban.id, canWrite: true });
    expect(context.audit).toEqual([expect.objectContaining({ action: "update", entityId: kanban.id })]);
    expect(realtime.sendSecurityEventToBusiness).toHaveBeenCalledWith(COMPANY, { reason: "permissions_changed" });
  });

  // Decision 16.100: the body's businessId used to be written back, so a
  // MASTER could move a permission onto another company's profile.
  it("never moves a permission to another company, even for a MASTER", async () => {
    const { context, kanban } = await seeded();

    await expect(
      context.update.execute(
        edit(kanban.id, { businessId: OTHER_COMPANY, profileAccessId: FOREIGN_PROFILE }),
        MASTER,
      ),
    ).rejects.toMatchObject({ code: "PROFILE_ACCESS_NOT_FOUND" });

    const row = context.permissions.permissions.find((permission) => permission.id === kanban.id);

    expect(row).toMatchObject({ businessId: COMPANY, profileAccessId: PROFILE });
  });

  it("is not a duplicate of itself, but refuses another row's label or resource", async () => {
    const { context, kanban } = await seeded();

    await expect(context.update.execute(edit(kanban.id), ADMIN)).resolves.toMatchObject({ id: kanban.id });

    await expect(
      context.update.execute(edit(kanban.id, { action: "Gerenciar Fornecedores" }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PERMISSION_ALREADY_EXISTS" });
    await expect(
      context.update.execute(edit(kanban.id, { permissionKey: "supplier_manage", action: "Novo rótulo" }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PERMISSION_ALREADY_ASSIGNED" });
  });

  it("refuses another company's permission by its current tenant, leaving it untouched", async () => {
    const { context, foreign } = await seeded();

    await expect(
      context.update.execute(edit(foreign.id, { canWrite: true }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "PERMISSION_NOT_FOUND" });
    expect(context.permissions.permissions.find((row) => row.id === foreign.id)?.canWrite).toBe(false);
  });

  it("refuses a BUSINESS_USER moving a permission into their own profile", async () => {
    const { context, kanban } = await seeded();

    await expect(
      context.update.execute(edit(kanban.id, { profileAccessId: OWN_PROFILE }), OPERATOR),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(context.permissions.permissions.find((row) => row.id === kanban.id)?.profileAccessId).toBe(PROFILE);
  });

  it("refuses a permission the actor's own session holds", async () => {
    const { context, kanban } = await seeded();
    const operator = context.users.user.find((row) => row.id === OPERATOR) as unknown as {
      profileAccess: { permissions: { id: string }[] };
    };
    operator.profileAccess.permissions.push({ id: kanban.id });

    await expect(context.update.execute(edit(kanban.id, { canWrite: true }), OPERATOR)).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("refuses an unknown permission with 404", async () => {
    const { context } = await seeded();

    await expect(context.update.execute(edit(GHOST), ADMIN)).rejects.toMatchObject({
      statusCode: 404,
      code: "PERMISSION_NOT_FOUND",
    });
  });

  it("rolls the change back when its audit entry fails", async () => {
    const { context, kanban } = await seeded();
    context.activities.createActivityIfEnabled.mockRejectedValueOnce(new Error("audit down"));

    await expect(context.update.execute(edit(kanban.id, { canWrite: true }), ADMIN)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(context.permissions.permissions.find((row) => row.id === kanban.id)?.canWrite).toBe(false);
    expect(realtime.sendSecurityEventToBusiness).not.toHaveBeenCalled();
  });
});

describe("listing permissions", () => {
  async function seeded() {
    const context = makeContext();
    await context.create.execute(grant("kanban_manage", "Gerenciar Kanban"), ADMIN);
    await context.create.execute(grant("supplier_manage", "Gerenciar Fornecedores", OWN_PROFILE), ADMIN);
    await context.create.execute(
      grant("kanban_manage", "Gerenciar Kanban", FOREIGN_PROFILE, OTHER_COMPANY),
      FOREIGN_ADMIN,
    );
    return context;
  }

  it("pins a company user to their company and hides a BUSINESS_USER's own profile", async () => {
    const context = await seeded();

    const admin = await context.list.execute({ userId: ADMIN, page: 1, pageSize: 10 });
    const operator = await context.list.execute({ userId: OPERATOR, page: 1, pageSize: 10 });

    expect(admin.total).toBe(2);
    expect(admin.data.every((row) => row.businessId === COMPANY)).toBe(true);
    expect(operator.data.map((row) => row.profileAccessId)).toEqual([PROFILE]);
  });

  it("refuses another company's id from a company user with TENANT_ACCESS_DENIED", async () => {
    const context = await seeded();

    await expect(
      context.list.execute({ userId: ADMIN, businessId: OTHER_COMPANY, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("makes the MASTER pick a company, then lists only that one", async () => {
    const context = await seeded();

    await expect(context.list.execute({ userId: MASTER, page: 1, pageSize: 10 })).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const other = await context.list.execute({ userId: MASTER, businessId: OTHER_COMPANY, page: 1, pageSize: 10 });

    expect(other.data.map((row) => row.profileAccessId)).toEqual([FOREIGN_PROFILE]);
  });

  it("refuses an unknown company with 404 and turns a repository failure into a 500", async () => {
    const context = await seeded();

    await expect(
      context.list.execute({ userId: MASTER, businessId: GHOST, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    vi.spyOn(context.permissions, "listPermission").mockRejectedValueOnce(new Error("down"));

    await expect(context.list.execute({ userId: ADMIN, page: 1, pageSize: 10 })).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it("lists one profile's permissions, never another company's", async () => {
    const context = await seeded();

    const mine = await context.byProfile.execute(PROFILE, COMPANY, ADMIN);
    const crossed = await context.byProfile.execute(FOREIGN_PROFILE, COMPANY, ADMIN);

    expect(mine.map((row) => row.permissionKey)).toEqual(["kanban_manage"]);
    expect(crossed).toEqual([]);
    await expect(context.byProfile.execute(PROFILE, COMPANY, GHOST)).rejects.toMatchObject({ statusCode: 404 });
  });
});
