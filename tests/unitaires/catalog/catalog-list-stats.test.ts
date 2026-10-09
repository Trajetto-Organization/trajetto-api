import "reflect-metadata";

import { describe, expect, it } from "vitest";

import { summarizeCatalogUsage } from "@/shared/pagination/catalog-usage";

import { ListProfileAccessUseCase } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-usecase";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { ListVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-usecase";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { ListFuelTypeUseCase } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-usecase";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

/**
 * The cards above Perfis de acesso, Tipos de veículo and Tipos de combustível
 * (decision 16.350): counted by the server over the company's whole search,
 * never the page on screen, never another company's rows; the fuel month is
 * the company's civil month and only for whoever may see refuelings.
 */
const A = "018fe800-0000-7000-8000-00000000000a";
const B = "018fe800-0000-7000-8000-00000000000b";

const FLEET_ON = { is_active: true, entitlements: [{ module: "FLEET", enabled: true }] };
const FLEET_OFF = { is_active: true, entitlements: [{ module: "DELIVERIES", enabled: true }] };

function usersReturning(user: object) {
  return { findUserById: async () => user } as never;
}

describe("summarizeCatalogUsage", () => {
  it("counts entries, links and unused entries, and names the leader", () => {
    expect(
      summarizeCatalogUsage([
        { id: "1", label: "Truck", count: 2 },
        { id: "2", label: "Van", count: 5 },
        { id: "3", label: "Carreta", count: 0 },
      ]),
    ).toEqual({
      total: 3,
      linked: 7,
      unused: 1,
      leader: { id: "2", label: "Van", count: 5 },
    });
  });

  it("breaks a tie by the pt-BR order of the label, so the card never flickers", () => {
    const { leader } = summarizeCatalogUsage([
      { id: "1", label: "Ônibus", count: 3 },
      { id: "2", label: "caminhão", count: 3 },
    ]);

    expect(leader?.label).toBe("caminhão");
  });

  it("has no leader while nothing points at any entry", () => {
    expect(summarizeCatalogUsage([{ id: "1", label: "Van", count: 0 }]).leader).toBeNull();
    expect(summarizeCatalogUsage([])).toEqual({ total: 0, linked: 0, unused: 0, leader: null });
  });
});

describe("access profile cards", () => {
  function setup(caller: object) {
    const users: Array<{ id: string; profileAccessId: string | null }> = [];
    const profiles = new InMemoryProfileAccessRepository({ users: () => users });
    const business = { findBusinessById: async (id: string) => ({ id }) } as never;

    profiles.profileAccess.push(
      { id: "p-fin", name: "Financeiro", businessId: A, created_at: new Date(1) },
      { id: "p-ops", name: "Operação", businessId: A, created_at: new Date(2) },
      { id: "p-own", name: "Supervisão", businessId: A, created_at: new Date(3) },
      { id: "p-idle", name: "Auditoria", businessId: A, created_at: new Date(4) },
      { id: "p-other", name: "Financeiro", businessId: B, created_at: new Date(5) },
    );

    users.push(
      { id: "u1", profileAccessId: "p-ops" },
      { id: "u2", profileAccessId: "p-ops" },
      { id: "u3", profileAccessId: "p-fin" },
      { id: "u4", profileAccessId: "p-own" },
      { id: "u5", profileAccessId: "p-own" },
      { id: "u6", profileAccessId: "p-own" },
      // Another company's crowd: never counted for A.
      ...Array.from({ length: 9 }, (_, index) => ({ id: `x${index}`, profileAccessId: "p-other" })),
    );

    return new ListProfileAccessUseCase(usersReturning(caller), profiles, business);
  }

  it("count the company's whole search, not the page on screen", async () => {
    const list = setup({ id: "admin", role: "BUSINESS_ADMIN", businessId: A });

    const result = await list.execute({ userId: "admin", page: 1, pageSize: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({
      total: 4,
      linkedUsers: 6,
      withoutUsers: 1,
      mostUsed: { id: "p-own", label: "Supervisão", count: 3 },
    });
  });

  it("leave out the profile a common user cannot see, as the table does", async () => {
    const list = setup({
      id: "operator",
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: "p-own",
    });

    const { meta } = await list.execute({ userId: "operator", page: 1, pageSize: 10 });

    expect(meta).toEqual({
      total: 3,
      linkedUsers: 3,
      withoutUsers: 1,
      mostUsed: { id: "p-ops", label: "Operação", count: 2 },
    });
  });

  it("follow the search like the pager", async () => {
    const list = setup({ id: "admin", role: "BUSINESS_ADMIN", businessId: A });

    const { meta, total } = await list.execute({
      userId: "admin",
      page: 1,
      pageSize: 10,
      search: "fin",
    });

    expect(total).toBe(1);
    expect(meta).toEqual({
      total: 1,
      linkedUsers: 1,
      withoutUsers: 0,
      mostUsed: { id: "p-fin", label: "Financeiro", count: 1 },
    });
  });
});

describe("vehicle type cards", () => {
  function setup() {
    const types = new InMemoryVehicleTypeRepository();
    const vehicles: Array<{ vehicleTypeId: string | null }> = [];

    types.vehicleSource = () => vehicles;

    const at = (ms: number) => new Date(ms);

    types.vehicleTypes.push(
      { id: "t-truck", description: "Truck", number_of_axles: 3, required_cnh_category: null, businessId: A, created_at: at(1), updated_at: at(1) },
      { id: "t-van", description: "Van", number_of_axles: 2, required_cnh_category: null, businessId: A, created_at: at(2), updated_at: at(2) },
      { id: "t-idle", description: "Bitrem", number_of_axles: 7, required_cnh_category: null, businessId: A, created_at: at(3), updated_at: at(3) },
      { id: "t-other", description: "Carreta", number_of_axles: 5, required_cnh_category: null, businessId: B, created_at: at(4), updated_at: at(4) },
    );

    vehicles.push(
      { vehicleTypeId: "t-van" },
      { vehicleTypeId: "t-van" },
      { vehicleTypeId: "t-truck" },
      { vehicleTypeId: null },
      ...Array.from({ length: 6 }, () => ({ vehicleTypeId: "t-other" })),
    );

    return new ListVehicleTypeUseCase(
      usersReturning({ id: "admin", role: "BUSINESS_ADMIN", businessId: A }),
      types,
    );
  }

  it("count the company's whole search, not the page on screen", async () => {
    const result = await setup().execute({ userId: "admin", page: 1, pageSize: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({
      total: 3,
      vehicles: 3,
      withoutVehicles: 1,
      mostUsed: { id: "t-van", label: "Van", count: 2 },
    });
  });

  it("have no leader when no vehicle uses the types found", async () => {
    const { meta } = await setup().execute({
      userId: "admin",
      page: 1,
      pageSize: 10,
      search: "bitrem",
    });

    expect(meta).toEqual({ total: 1, vehicles: 0, withoutVehicles: 1, mostUsed: null });
  });
});

describe("fuel type cards", () => {
  // 15/10/2026 in São Paulo (UTC-3): the business month is October.
  const NOW = new Date("2026-10-15T12:00:00Z");

  function setup(caller: object, timezone = "America/Sao_Paulo") {
    const fuelTypes = new InMemoryFuelTypeRepository();
    const business = {
      findBusinessById: async (id: string) => ({ id, timezone }),
    } as never;

    const at = new Date(0);

    fuelTypes.fuelTypes.push(
      { id: "f-diesel", description: "Diesel", businessId: A, created_at: at, updated_at: at },
      { id: "f-gas", description: "Gasolina", businessId: A, created_at: at, updated_at: at },
      { id: "f-gnv", description: "GNV", businessId: A, created_at: at, updated_at: at },
      { id: "f-other", description: "Diesel", businessId: B, created_at: at, updated_at: at },
    );

    fuelTypes.vehicleFuelTypeIds.push("f-diesel", "f-diesel", "f-gas", "f-other", "f-other");

    const refuel = (fuelTypeId: string, businessId: string, iso: string, liters: number, amount: number) => ({
      fuelTypeId,
      businessId,
      refueling_date: new Date(iso),
      liters_amount: liters,
      total_amount: amount,
    });

    fuelTypes.fuelRows.push(
      // 30/09 23:00 in São Paulo although already October in UTC: September.
      refuel("f-diesel", A, "2026-10-01T02:00:00Z", 999, 9999),
      // 01/10 00:30 in São Paulo: October.
      refuel("f-diesel", A, "2026-10-01T03:30:00Z", 100, 600),
      refuel("f-diesel", A, "2026-10-10T15:00:00Z", 200, 1260),
      refuel("f-gas", A, "2026-10-12T15:00:00Z", 40, 260),
      // 31/10 23:30 in São Paulo although November in UTC: still October.
      refuel("f-gas", A, "2026-11-01T02:30:00Z", 10, 65),
      // Another company's October: never counted for A.
      refuel("f-other", B, "2026-10-05T12:00:00Z", 5000, 30000),
    );

    return new ListFuelTypeUseCase(usersReturning(caller), fuelTypes, business);
  }

  const admin = { id: "admin", role: "BUSINESS_ADMIN", businessId: A, business: FLEET_ON };

  it("sum the company's business month and name the fuel most refueled", async () => {
    const { meta, total } = await setup(admin).execute({
      userId: "admin",
      page: 1,
      pageSize: 1,
      now: NOW,
    });

    expect(total).toBe(3);
    expect(meta).toEqual({
      total: 3,
      vehicles: 3,
      withoutVehicles: 1,
      mostUsed: { id: "f-diesel", label: "Diesel", count: 2 },
      month: {
        month: "2026-10",
        refuelings: 4,
        liters: 350,
        amount: 2185,
        mostRefueled: {
          id: "f-diesel",
          label: "Diesel",
          refuelings: 2,
          liters: 300,
          // (600 + 1260) / 300, weighted by liters.
          averagePricePerLiter: 6.2,
        },
      },
    });
  });

  it("read the month in the company's own time zone", async () => {
    // Manaus is UTC-4: 01/11 02:30 UTC is 31/10 22:30 there, still October,
    // and 01/10 03:30 UTC is 30/09 23:30, still September.
    const { meta } = await setup(admin, "America/Manaus").execute({
      userId: "admin",
      page: 1,
      pageSize: 10,
      now: NOW,
    });

    expect(meta.month?.refuelings).toBe(3);
    expect(meta.month?.liters).toBe(250);
  });

  it("leave the month out when the company did not hire Gestão de Frotas", async () => {
    const { meta } = await setup({ ...admin, business: FLEET_OFF }).execute({
      userId: "admin",
      page: 1,
      pageSize: 10,
      now: NOW,
    });

    expect(meta.month).toBeNull();
    // The catalog's own numbers stay.
    expect(meta.total).toBe(3);
    expect(meta.vehicles).toBe(3);
  });

  it("leave the month out for a profile that does not read Abastecimentos", async () => {
    const catalogOnly = {
      id: "user",
      role: "BUSINESS_USER",
      businessId: A,
      business: FLEET_ON,
      profileAccess: {
        permissions: [
          { id: "1", permissionKey: "fuel_type_manage", action: "x", canRead: true, canWrite: false },
        ],
      },
    };

    const { meta } = await setup(catalogOnly).execute({
      userId: "user",
      page: 1,
      pageSize: 10,
      now: NOW,
    });

    expect(meta.month).toBeNull();
  });

  it("show the month to a profile that reads Abastecimentos", async () => {
    const withRefuelings = {
      id: "user",
      role: "BUSINESS_USER",
      businessId: A,
      business: FLEET_ON,
      profileAccess: {
        permissions: [
          { id: "1", permissionKey: "fuel_type_manage", action: "x", canRead: true, canWrite: false },
          { id: "2", permissionKey: "fuel_manage", action: "x", canRead: true, canWrite: false },
        ],
      },
    };

    const { meta } = await setup(withRefuelings).execute({
      userId: "user",
      page: 1,
      pageSize: 10,
      now: NOW,
    });

    expect(meta.month?.refuelings).toBe(4);
  });

  it("say nothing was refueled when the month is empty", async () => {
    const { meta } = await setup(admin).execute({
      userId: "admin",
      page: 1,
      pageSize: 10,
      now: new Date("2027-03-10T12:00:00Z"),
    });

    expect(meta.month).toEqual({
      month: "2027-03",
      refuelings: 0,
      liters: 0,
      amount: 0,
      mostRefueled: null,
    });
  });
});
