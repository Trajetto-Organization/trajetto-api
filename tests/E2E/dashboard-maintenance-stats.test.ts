import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";
import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";

import { zonedWallTimeToUtc } from "@/shared/time/business-day";

/**
 * The "Manutenção da frota" card (Atrasada / A vencer / Em dia), counted in
 * the company's calendar.
 *
 * The due day is the last maintenance's civil day plus the interval in
 * months, and it is compared with the company's today. It used to be the
 * server's clock against an instant: at 21:30 in Manaus (01:30 UTC of the next
 * day) a vehicle due today was already "Atrasada", and so was one due
 * tomorrow when its date had been sent as a plain "YYYY-MM-DD".
 *
 * The same rows go through the database and through the in-memory twin, so
 * the two stay one rule (decision 13.2).
 */
const prisma = new PrismaClient();

const MANAUS = "America/Manaus"; // UTC-4

const CARRIER = "018fd300-0000-7000-8000-00000000000a";
const OTHER = "018fd300-0000-7000-8000-00000000000b";
const ADMIN = "018fd300-0000-7000-8000-0000000000a1";

// 21:30 of 27/09 in Manaus is 01:30 of 28/09 in UTC.
const NOW = zonedWallTimeToUtc(MANAUS, 2026, 9, 27, 21, 30);
const TODAY = "2026-09-27";

type VehicleSeed = Pick<
  Prisma.VehicleUncheckedCreateInput,
  | "last_maintenance_date"
  | "maintenance_interval_months"
  | "current_mileage"
  | "last_maintenance_mileage"
  | "maintenance_interval_km"
> & { label: string };

const manaus = (month: number, day: number, hour = 0, minute = 0) =>
  zonedWallTimeToUtc(MANAUS, 2026, month, day, hour, minute);

const quiet = {
  current_mileage: 1000,
  last_maintenance_mileage: 500,
  maintenance_interval_km: 10000,
};

/** One vehicle per edge, each labelled with the answer it must get. */
const CARRIER_VEHICLES: VehicleSeed[] = [
  {
    // Picked in the web (local midnight, 04:00 UTC): due today, not late.
    label: "vence hoje",
    last_maintenance_date: manaus(3, 27),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    // Sent as "2026-03-28" (UTC midnight): the day is the 28th, due tomorrow.
    label: "vence amanhã, data sem hora",
    last_maintenance_date: new Date("2026-03-28T00:00:00.000Z"),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    label: "venceu ontem",
    last_maintenance_date: manaus(3, 26, 15),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    // 23:00 in Manaus is already the 28th in UTC; the company's day is the 27th.
    label: "vence em 30 dias",
    last_maintenance_date: manaus(4, 27, 23),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    label: "vence em 31 dias",
    last_maintenance_date: manaus(4, 28, 12),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    label: "em dia",
    last_maintenance_date: manaus(9, 1, 10),
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    label: "em dia pela data, atrasada pelo km",
    last_maintenance_date: manaus(9, 1, 10),
    maintenance_interval_months: 6,
    current_mileage: 20000,
    last_maintenance_mileage: 5000,
    maintenance_interval_km: 10000,
  },
  {
    label: "sem registro",
    last_maintenance_date: null,
    maintenance_interval_months: 6,
    ...quiet,
  },
  {
    // 31/08 + 1 month is 30/09, the end of September, not 01/10.
    label: "fim de mês",
    last_maintenance_date: manaus(8, 31, 12),
    maintenance_interval_months: 1,
    ...quiet,
  },
];

// Late by every measure: counted in this company, never in the carrier's.
const OTHER_VEHICLES: VehicleSeed[] = [
  {
    label: "outra empresa, atrasada",
    last_maintenance_date: manaus(1, 5, 12),
    maintenance_interval_months: 1,
    ...quiet,
  },
  {
    label: "outra empresa, atrasada pelo km",
    last_maintenance_date: manaus(9, 1, 12),
    maintenance_interval_months: 6,
    current_mileage: 90000,
    last_maintenance_mileage: 100,
    maintenance_interval_km: 10000,
  },
];

const EXPECTED = {
  overdue: 2, // venceu ontem; atrasada pelo km
  pending: 5, // vence hoje; vence amanhã; vence em 30 dias; sem registro; fim de mês
  recent: 2, // vence em 31 dias; em dia
};

const twin = new InMemoryDashboardRepository();

async function seedBusiness(id: string, timezone: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "92999999999",
      email: `manutencao-${randomUUID()}@exemplo.com.br`,
      timezone,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedVehicles(businessId: string, vehicles: VehicleSeed[]): Promise<void> {
  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId },
  });

  for (const { label, ...vehicle } of vehicles) {
    await prisma.vehicle.create({
      data: {
        ...vehicle,
        description: label,
        license_plate: `MNT${Math.floor(Math.random() * 9000) + 1000}`,
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date("2024-01-10T12:00:00.000Z"),
        fleet_type: "OWNED",
        renavam: `renavam-mnt-${randomUUID()}`,
        manufacturing_year: new Date("2024-01-01T12:00:00.000Z"),
        model_year: new Date("2024-01-01T12:00:00.000Z"),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId,
        fuelTypeId: fuelType.id,
      },
    });

    twin.addVehicle({
      businessId,
      status: "ACTIVE",
      last_maintenance_date: (vehicle.last_maintenance_date as Date | null) ?? null,
      maintenance_interval_months: vehicle.maintenance_interval_months,
      current_mileage: vehicle.current_mileage,
      last_maintenance_mileage: (vehicle.last_maintenance_mileage as number | null) ?? null,
      maintenance_interval_km: vehicle.maintenance_interval_km,
    });
  }
}

beforeAll(async () => {
  await seedBusiness(CARRIER, MANAUS);
  await seedBusiness(OTHER, "America/Sao_Paulo");

  await seedVehicles(CARRIER, CARRIER_VEHICLES);
  await seedVehicles(OTHER, OTHER_VEHICLES);

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Gestora da frota",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });
}, 90_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: ADMIN } });
  await prisma.vehicle.deleteMany({ where: { businessId: { in: [CARRIER, OTHER] } } });
  await prisma.fuelType.deleteMany({ where: { businessId: { in: [CARRIER, OTHER] } } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [CARRIER, OTHER] } } });

  await prisma.$disconnect();
});

describe("the fleet maintenance card, in the company's day", () => {
  it("at 21:30 in Manaus, a vehicle due today or tomorrow is not late yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    const overview = await new GetDashboardOverviewUseCase(
      new UserRepository(),
      new DashboardRepository(),
      new ActivityRepository(),
      new DeliveryRepository(),
      new BusinessRepository(),
      new OperationDayRepository(),
    ).execute({ userId: ADMIN });

    expect(overview.maintenanceStats).toEqual(EXPECTED);
  });

  it("the database and the twin give the same answer for the same rows", async () => {
    const params = { today: TODAY, timeZone: MANAUS };

    const database = await new DashboardRepository().getMaintenanceStats(params, CARRIER);
    const memory = await twin.getMaintenanceStats(params, CARRIER);

    expect(database).toEqual(EXPECTED);
    expect(memory).toEqual(database);
  });

  it("clamps the end of the month in both: 31/08 + 1 month is late on 01/10", async () => {
    // "fim de mês" is due 30/09. A rollover to 01/10 would still call it
    // "A vencer" on 01/10 (4 late, 4 due).
    const params = { today: "2026-10-01", timeZone: MANAUS };

    const database = await new DashboardRepository().getMaintenanceStats(params, CARRIER);
    const memory = await twin.getMaintenanceStats(params, CARRIER);

    // Late by 01/10: venceu ontem, vence hoje, vence amanhã, fim de mês, km.
    // Within 30 days (up to 31/10): 30 and 31 days, plus the unrecorded one.
    expect(database).toEqual({ overdue: 5, pending: 3, recent: 1 });
    expect(memory).toEqual(database);
  });

  it("never counts another company's vehicles", async () => {
    const params = { today: TODAY, timeZone: MANAUS };

    for (const repository of [new DashboardRepository(), twin]) {
      expect(await repository.getMaintenanceStats(params, OTHER)).toEqual({
        overdue: 2,
        pending: 0,
        recent: 0,
      });

      expect(await repository.countVehiclesByStatus(OTHER)).toEqual({
        ACTIVE: OTHER_VEHICLES.length,
        INACTIVE: 0,
        BLOCKED: 0,
        IN_ROUTE: 0,
      });
    }
  });
});
