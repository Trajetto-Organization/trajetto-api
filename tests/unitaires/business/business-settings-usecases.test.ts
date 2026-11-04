import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());
const entitlements = vi.hoisted(() => ({
  getBusinessEntitlements: vi.fn(),
}));

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent }));
// The module table is SQL (the E2E of the route covers it); here only how
// the use case composes it.
vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);
// The twins have no database to open a transaction on; the row lock taken
// inside it is SQL, proven by tests/E2E/business-settings-http.test.ts.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $queryRaw: async () => [] }),
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBusinessSettingsRepository } from "@/modules/business/repositories/in-memory/in-memory-business-settings-repository";

import {
  GetBusinessSettingsUseCase,
  UpdateBusinessSettingsUseCase,
} from "@/modules/business/usecases/manage-settings/manage-settings-usecase";

/**
 * "Configurações da empresa" (plan of 02/11/2026, M1; decision D11) on the
 * in-memory twins: who may read and save them, the defaults of a company
 * that never saved, the module rule (M6), and the audit entry that commits
 * with a real change and only then.
 */
const ALFA = "018f5c00-0000-7000-8000-0000000000a0";
const BETA = "018f5c00-0000-7000-8000-0000000000b0";
const MISSING = "018f5c00-0000-7000-8000-0000000000ee";

const MASTER = "018f5c00-0000-7000-8000-0000000000f1";
const ADMIN_ALFA = "018f5c00-0000-7000-8000-0000000000a1";
const USER_ALFA = "018f5c00-0000-7000-8000-0000000000a2";
const ADMIN_BETA = "018f5c00-0000-7000-8000-0000000000b1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let settings: InMemoryBusinessSettingsRepository;
const outbox = { publish: vi.fn(async () => undefined) };

const read = () => new GetBusinessSettingsUseCase(users, businesses, settings);
const save = () =>
  new UpdateBusinessSettingsUseCase(
    users,
    businesses,
    settings,
    outbox as never,
  );

beforeEach(() => {
  vi.clearAllMocks();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  settings = new InMemoryBusinessSettingsRepository();

  entitlements.getBusinessEntitlements.mockResolvedValue([
    { module: "FLEET", enabled: true },
    { module: "DELIVERIES", enabled: true },
  ]);

  users.user.push(
    {
      id: MASTER,
      role: "MASTER",
      businessId: null,
      name: "Mestre",
      email: "mestre@trajetto.com.br",
    } as unknown as User,
    {
      id: ADMIN_ALFA,
      role: "BUSINESS_ADMIN",
      businessId: ALFA,
      name: "Ana Admin",
      email: "ana@alfa.com.br",
    } as unknown as User,
    {
      id: USER_ALFA,
      role: "BUSINESS_USER",
      businessId: ALFA,
      name: "Caio Colaborador",
      email: "caio@alfa.com.br",
    } as unknown as User,
    {
      id: ADMIN_BETA,
      role: "BUSINESS_ADMIN",
      businessId: BETA,
      name: "Bia Admin",
      email: "bia@beta.com.br",
    } as unknown as User,
  );

  businesses.business.push(
    { id: ALFA, corporate_reason: "Alfa Transportes Ltda" } as Business,
    { id: BETA, corporate_reason: "Beta Logística Ltda" } as Business,
  );
});

describe("reading the company's settings", () => {
  it("gives a company that never saved the defaults, and says nobody saved", async () => {
    const view = await read().execute({ userId: ADMIN_ALFA, businessId: ALFA });

    expect(view).toEqual({
      businessId: ALFA,
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
      available: { checklist: true, geofence: true },
      limits: { geofence_radius_min_m: 50, geofence_radius_max_m: 5000 },
      updated_at: null,
      updated_by: null,
    });
  });

  it("says which sections apply by the modules on (M6)", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "FLEET", enabled: true },
      { module: "DELIVERIES", enabled: false },
    ]);

    expect(
      (await read().execute({ userId: ADMIN_ALFA, businessId: ALFA }))
        .available,
    ).toEqual({ checklist: false, geofence: false });

    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "DELIVERIES", enabled: true },
    ]);

    expect(
      (await read().execute({ userId: ADMIN_ALFA, businessId: ALFA }))
        .available,
    ).toEqual({ checklist: false, geofence: true });
  });

  it("is open to the company's admin and to a MASTER only", async () => {
    await expect(
      read().execute({ userId: MASTER, businessId: BETA }),
    ).resolves.toMatchObject({ businessId: BETA });

    await expect(
      read().execute({ userId: USER_ALFA, businessId: ALFA }),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" });
  });

  it("refuses another company's admin the same way for an existing and a missing id", async () => {
    for (const businessId of [BETA, MISSING]) {
      await expect(
        read().execute({ userId: ADMIN_ALFA, businessId }),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "TENANT_ACCESS_DENIED",
      });
    }
  });

  it("answers 404 BUSINESS_NOT_FOUND to a MASTER asking for a missing company", async () => {
    await expect(
      read().execute({ userId: MASTER, businessId: MISSING }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });
});

describe("saving the company's settings", () => {
  it("writes the fields given, keeps the others, and records who saved", async () => {
    const view = await save().execute({
      userId: ADMIN_ALFA,
      businessId: ALFA,
      data: { arrival_geofence_mode: "BLOCK", arrival_geofence_radius_m: 300 },
    });

    expect(view).toMatchObject({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
      updated_by: { id: ADMIN_ALFA, name: "Ana Admin" },
    });
    expect(view.updated_at).toBeInstanceOf(Date);

    const second = await save().execute({
      userId: MASTER,
      businessId: ALFA,
      data: { checklist_requirement: "ROUTE_START" },
    });

    expect(second).toMatchObject({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
      updated_by: { id: MASTER, name: "Mestre" },
    });
  });

  it("publishes the movement — before, after and who — with the write", async () => {
    await save().execute({
      userId: ADMIN_ALFA,
      businessId: ALFA,
      data: {
        checklist_requirement: "ROUTE_START_AND_END",
        arrival_geofence_mode: "ALERT",
      },
    });

    expect(outbox.publish).toHaveBeenCalledTimes(1);
    expect(outbox.publish).toHaveBeenCalledWith(expect.anything(), {
      topic: "business-settings.changed",
      aggregateType: "business",
      aggregateId: ALFA,
      businessId: ALFA,
      actorId: ADMIN_ALFA,
      payload: {
        businessId: ALFA,
        businessName: "Alfa Transportes Ltda",
        changes: [
          {
            field: "checklist_requirement",
            from: "NONE",
            to: "ROUTE_START_AND_END",
          },
          { field: "arrival_geofence_mode", from: "DISABLED", to: "ALERT" },
        ],
        description:
          "Checklist da rota: Não exigir → No início e no fim da rota; Apontamento fora do raio do cliente: Desativado → Alertar",
        actor: {
          id: ADMIN_ALFA,
          name: "Ana Admin",
          email: "ana@alfa.com.br",
          role: "BUSINESS_ADMIN",
        },
      },
    });
    // The open screens and the drivers' apps refetch after the commit.
    expect(sendCatalogChangedEvent).toHaveBeenCalledWith(ALFA, "settings");
  });

  it("saving what is already there writes nothing, audits nothing, wakes nobody", async () => {
    await save().execute({
      userId: ADMIN_ALFA,
      businessId: ALFA,
      data: { arrival_geofence_radius_m: 500, checklist_requirement: "NONE" },
    });

    expect(settings.settings).toHaveLength(0);
    expect(outbox.publish).not.toHaveBeenCalled();
    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("refuses a collaborator and another company's admin before writing", async () => {
    await expect(
      save().execute({
        userId: USER_ALFA,
        businessId: ALFA,
        data: { arrival_geofence_mode: "BLOCK" },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" });

    await expect(
      save().execute({
        userId: ADMIN_BETA,
        businessId: ALFA,
        data: { arrival_geofence_mode: "BLOCK" },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    expect(settings.settings).toHaveLength(0);
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it("keeps each company's settings apart", async () => {
    await save().execute({
      userId: ADMIN_BETA,
      businessId: BETA,
      data: { arrival_geofence_mode: "BLOCK" },
    });

    expect(
      (await read().execute({ userId: ADMIN_ALFA, businessId: ALFA }))
        .arrival_geofence_mode,
    ).toBe("DISABLED");
  });

  it("refuses an unknown caller and a missing company", async () => {
    await expect(
      save().execute({
        userId: MISSING,
        businessId: ALFA,
        data: { arrival_geofence_mode: "BLOCK" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      save().execute({
        userId: MASTER,
        businessId: MISSING,
        data: { arrival_geofence_mode: "BLOCK" },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });
});
