import { beforeEach, describe, expect, it, vi } from "vitest";

const realtime = vi.hoisted(() => ({
  sendCatalogChangedEvent: vi.fn(),
  sendSecurityEventToBusiness: vi.fn(),
}));

// The socket server is not up in unit tests; what matters is that the
// catalog hint goes out for the right company, and only after a commit.
vi.mock("@/websocket", () => realtime);

const tx = vi.hoisted(() => ({
  current: { $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}) },
}));

vi.mock("@/../infra/database", () => ({
  default: { $transaction: (run: (client: unknown) => Promise<unknown>) => tx.current.$transaction(run) },
}));

import { CreateProfileAccessUseCase } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-usecase";
import { UpdateProfileAccessUseCase } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-usecase";
import { ListProfileAccessUseCase } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-usecase";
import { SearchProfileCursorUseCase } from "@/modules/profile-access/usecases/search-profile-cursor/search-profile-cursor-usecase";

import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { inMemoryTransaction } from "@/shared/in-memory/in-memory-transaction";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * Access profiles on the twins: one name per company whatever the case, a
 * profile stays in its company, nobody renames their own profile, every
 * write is checked against the profile's current tenant and commits with its
 * audit entry, and the pickers in other tabs hear about it only after the
 * commit (catalogChanged `profile_access`, decision 2.3).
 */
const COMPANY = "018f0000-0000-7000-8000-00000000000a";
const OTHER_COMPANY = "018f0000-0000-7000-8000-00000000000b";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const OPERATOR = "018f0000-0000-7000-8000-0000000000a2";
const MASTER = "018f0000-0000-7000-8000-0000000000a4";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";
const PROFILE = "018f0000-0000-7000-8000-0000000000c1";
const OWN_PROFILE = "018f0000-0000-7000-8000-0000000000c2";
const FOREIGN_PROFILE = "018f0000-0000-7000-8000-0000000000c3";

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const profiles = new InMemoryProfileAccessRepository({ users: () => users.user });
  const audit: unknown[] = [];

  const activities = {
    createActivityIfEnabled: vi.fn(async (entry: unknown) => {
      audit.push(entry);
    }),
  };

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: COMPANY, profileAccessId: null } as unknown as User,
    { id: OPERATOR, role: "BUSINESS_USER", businessId: COMPANY, profileAccessId: OWN_PROFILE } as unknown as User,
    { id: MASTER, role: "MASTER", businessId: null, profileAccessId: null } as unknown as User,
  );
  businesses.business.push(
    { ...BUSINESS_COLUMN_DEFAULTS, id: COMPANY } as unknown as Business,
    { ...BUSINESS_COLUMN_DEFAULTS, id: OTHER_COMPANY } as unknown as Business,
  );
  profiles.profileAccess.push(
    { id: PROFILE, name: "Financeiro", businessId: COMPANY, created_at: new Date(Date.UTC(2026, 0, 1)) },
    { id: OWN_PROFILE, name: "Operação", businessId: COMPANY, created_at: new Date(Date.UTC(2026, 0, 2)) },
    { id: FOREIGN_PROFILE, name: "Financeiro", businessId: OTHER_COMPANY, created_at: new Date(Date.UTC(2026, 0, 3)) },
  );

  const transaction = inMemoryTransaction([profiles, audit]);
  tx.current = transaction;

  const service = activities as unknown as NotificationService;

  return {
    profiles,
    audit,
    activities,
    transaction,
    create: new CreateProfileAccessUseCase(users, profiles, businesses, service),
    update: new UpdateProfileAccessUseCase(users, profiles, businesses, service),
    list: new ListProfileAccessUseCase(users, profiles, businesses),
    search: new SearchProfileCursorUseCase(users, profiles, businesses),
  };
}

beforeEach(() => {
  realtime.sendCatalogChangedEvent.mockClear();
});

describe("creating a profile", () => {
  it("creates, audits and tells the pickers after the commit", async () => {
    const context = makeContext();

    const created = await context.create.execute({ name: "Manutenção", businessId: COMPANY }, ADMIN);

    expect(context.profiles.profileAccess.map((row) => row.id)).toContain(created.id);
    expect(context.audit).toEqual([expect.objectContaining({ action: "create", entityId: created.id })]);
    expect(realtime.sendCatalogChangedEvent).toHaveBeenCalledWith(COMPANY, "profile_access");
  });

  it("refuses the same name in another case with 409, while another company may use it", async () => {
    const context = makeContext();

    await expect(
      context.create.execute({ name: "FINANCEIRO", businessId: COMPANY }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PROFILE_ACCESS_ALREADY_EXISTS" });

    await expect(
      context.create.execute({ name: "Operação", businessId: OTHER_COMPANY }, MASTER),
    ).resolves.toMatchObject({ businessId: OTHER_COMPANY });
  });

  it("refuses writing into another company with TENANT_ACCESS_DENIED", async () => {
    const context = makeContext();

    await expect(
      context.create.execute({ name: "Intrusos", businessId: OTHER_COMPANY }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(context.profiles.profileAccess).toHaveLength(3);
  });

  it("refuses an unknown user or company with 404", async () => {
    const context = makeContext();

    await expect(context.create.execute({ name: "X", businessId: COMPANY }, GHOST)).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    await expect(context.create.execute({ name: "X", businessId: GHOST }, MASTER)).rejects.toMatchObject({
      statusCode: 404,
      code: "BUSINESS_NOT_FOUND",
    });
  });

  it("rolls the profile back when its audit entry fails, and announces nothing", async () => {
    const context = makeContext();
    context.activities.createActivityIfEnabled.mockRejectedValueOnce(new Error("audit down"));

    await expect(
      context.create.execute({ name: "Manutenção", businessId: COMPANY }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(context.profiles.profileAccess).toHaveLength(3);
    expect(realtime.sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});

describe("updating a profile", () => {
  it("renames, audits and announces", async () => {
    const context = makeContext();

    const updated = await context.update.execute({ profileAccessId: PROFILE, businessId: COMPANY, name: "Finanças" }, ADMIN);

    expect(updated.name).toBe("Finanças");
    expect(context.audit).toHaveLength(1);
    expect(realtime.sendCatalogChangedEvent).toHaveBeenCalledWith(COMPANY, "profile_access");
  });

  it("writes nothing when the name did not change", async () => {
    const context = makeContext();

    await context.update.execute({ profileAccessId: PROFILE, businessId: COMPANY, name: "Financeiro" }, ADMIN);

    expect(context.audit).toHaveLength(0);
    expect(context.transaction.stats.committed).toBe(0);
    expect(realtime.sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("refuses another profile's name, but accepts a case change of its own", async () => {
    const context = makeContext();

    await expect(
      context.update.execute({ profileAccessId: PROFILE, businessId: COMPANY, name: "operação" }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "PROFILE_ACCESS_ALREADY_EXISTS" });

    await expect(
      context.update.execute({ profileAccessId: PROFILE, businessId: COMPANY, name: "FINANCEIRO" }, ADMIN),
    ).resolves.toMatchObject({ name: "FINANCEIRO" });
  });

  it("keeps a profile in its company", async () => {
    const context = makeContext();

    await expect(
      context.update.execute({ profileAccessId: PROFILE, businessId: OTHER_COMPANY, name: "Movido" }, MASTER),
    ).rejects.toMatchObject({ statusCode: 409, code: "PROFILE_ACCESS_BUSINESS_LOCKED" });
    expect(context.profiles.profileAccess.find((row) => row.id === PROFILE)?.businessId).toBe(COMPANY);
  });

  it("refuses another company's profile by its current tenant, whatever the body says", async () => {
    const context = makeContext();

    await expect(
      context.update.execute({ profileAccessId: FOREIGN_PROFILE, businessId: COMPANY, name: "Tomado" }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "PROFILE_ACCESS_NOT_FOUND" });
    expect(context.profiles.profileAccess.find((row) => row.id === FOREIGN_PROFILE)?.name).toBe("Financeiro");
  });

  it("refuses renaming one's own profile and an unknown profile", async () => {
    const context = makeContext();

    await expect(
      context.update.execute({ profileAccessId: OWN_PROFILE, businessId: COMPANY, name: "Chefia" }, OPERATOR),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      context.update.execute({ profileAccessId: GHOST, businessId: COMPANY, name: "X" }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "PROFILE_ACCESS_NOT_FOUND" });
  });

  it("rolls the rename back when its audit entry fails", async () => {
    const context = makeContext();
    context.activities.createActivityIfEnabled.mockRejectedValueOnce(new Error("audit down"));

    await expect(
      context.update.execute({ profileAccessId: PROFILE, businessId: COMPANY, name: "Finanças" }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(context.profiles.profileAccess.find((row) => row.id === PROFILE)?.name).toBe("Financeiro");
    expect(realtime.sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});

describe("listing and searching profiles", () => {
  it("pins a company user to their company and hides a BUSINESS_USER's own profile", async () => {
    const context = makeContext();

    const admin = await context.list.execute({ userId: ADMIN, page: 1, pageSize: 10 });
    const operator = await context.list.execute({ userId: OPERATOR, page: 1, pageSize: 10 });

    expect(admin.data.map((row) => row.id).sort()).toEqual([PROFILE, OWN_PROFILE].sort());
    expect(admin.data.find((row) => row.id === OWN_PROFILE)?.usersCount).toBe(1);
    expect(operator.data.map((row) => row.id)).toEqual([PROFILE]);
  });

  it("refuses another company's id from a company user, and makes the MASTER pick one", async () => {
    const context = makeContext();

    await expect(
      context.list.execute({ userId: ADMIN, businessId: OTHER_COMPANY, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    await expect(context.list.execute({ userId: MASTER, page: 1, pageSize: 10 })).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const other = await context.list.execute({ userId: MASTER, businessId: OTHER_COMPANY, page: 1, pageSize: 10 });

    expect(other.data.map((row) => row.id)).toEqual([FOREIGN_PROFILE]);
  });

  it("searches by name, newest first, paged by cursor", async () => {
    const context = makeContext();

    const first = await context.search.execute({ userId: ADMIN, businessId: COMPANY, limit: 1 });

    expect(first.data.map((row) => row.id)).toEqual([OWN_PROFILE]);
    expect(first.hasMore).toBe(true);

    const second = await context.search.execute({
      userId: ADMIN,
      businessId: COMPANY,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.data.map((row) => row.id)).toEqual([PROFILE]);
    expect(second.hasMore).toBe(false);

    const typed = await context.search.execute({ userId: ADMIN, businessId: COMPANY, search: "finan" });

    expect(typed.data.map((row) => row.id)).toEqual([PROFILE]);
  });

  it("hides a BUSINESS_USER's own profile only in the editable picker", async () => {
    const context = makeContext();

    const userForm = await context.search.execute({ userId: OPERATOR, businessId: COMPANY });
    const editable = await context.search.execute({ userId: OPERATOR, businessId: COMPANY, editable: true });

    expect(userForm.data.map((row) => row.id)).toContain(OWN_PROFILE);
    expect(editable.data.map((row) => row.id)).not.toContain(OWN_PROFILE);
  });

  it("refuses another company's picker, an unknown company and a repository failure", async () => {
    const context = makeContext();

    await expect(context.search.execute({ userId: ADMIN, businessId: OTHER_COMPANY })).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(context.search.execute({ userId: MASTER, businessId: GHOST })).rejects.toMatchObject({
      statusCode: 404,
      code: "BUSINESS_NOT_FOUND",
    });

    vi.spyOn(context.profiles, "searchProfileAccessWithCursor").mockRejectedValueOnce(new Error("down"));

    await expect(context.search.execute({ userId: ADMIN, businessId: COMPANY })).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
