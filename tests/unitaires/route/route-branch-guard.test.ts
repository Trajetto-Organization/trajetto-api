import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const modules = vi.hoisted(() => ({ fleet: true, asked: 0 }));

vi.mock("@/shared/entitlements/entitlement-service", () => ({
  hasModule: async (_businessId: string, module: string) => {
    modules.asked += 1;
    return module === "FLEET" ? modules.fleet : true;
  },
}));

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { RouteBranchGuard } from "@/modules/route/usecases/shared/route-branch-guard";

/**
 * Releasing a route whose checklist the company asks for, when the record
 * branch of that checklist cannot be resolved (contract C1 of 03/11/2026).
 *
 * The departure checklist is filed under the vehicle's branch, else the
 * driver's, else the company's single active branch. With none of them the
 * driver's checklist is refused (BRANCH_REQUIRED) and, the checklist being
 * required, the route never starts: the driver stuck on the street over an
 * admin's blank field. The release is where the dispatcher can still fix it,
 * so it answers 409 ROUTE_BRANCH_REQUIRED naming the plate and the driver.
 */
const CARRIER = "018fb500-0000-7000-8000-00000000000a";
const OTHER = "018fb500-0000-7000-8000-00000000000b";

const VEHICLE = "018fb500-0000-7000-8000-0000000000c1";
const DRIVER = "018fb500-0000-7000-8000-0000000000d1";

const HEAD_OFFICE = "018fb500-0000-7000-8000-0000000000b1";
const SECOND_BRANCH = "018fb500-0000-7000-8000-0000000000b2";
const THIRD_BRANCH = "018fb500-0000-7000-8000-0000000000b3";
const FOREIGN_BRANCH = "018fb500-0000-7000-8000-0000000000b9";

type Requirement = "NONE" | "ROUTE_START" | "ROUTE_END" | "ROUTE_START_AND_END";

interface World {
  requirement: Requirement | null;
  vehicleBranchId: string | null;
  driverBranchId: string | null;
  branches: Branch[];
}

function guardFor(world: World) {
  const reads = { vehicle: 0, driver: 0 };

  const branches = new InMemoryBranchRepository();
  branches.branches.push(...world.branches);

  const guard = new RouteBranchGuard(
    {
      findByBusinessId: async () =>
        world.requirement
          ? { businessId: CARRIER, checklist_requirement: world.requirement }
          : null,
    } as never,
    {
      findVehicleById: async (id: string) => {
        reads.vehicle += 1;
        return id === VEHICLE
          ? {
              id: VEHICLE,
              businessId: CARRIER,
              license_plate: "RBR4E21",
              branchId: world.vehicleBranchId,
            }
          : null;
      },
    } as never,
    {
      findDriverById: async (id: string) => {
        reads.driver += 1;
        return id === DRIVER
          ? {
              id: DRIVER,
              businessId: CARRIER,
              name: "Rita Barros",
              branchId: world.driverBranchId,
            }
          : null;
      },
    } as never,
    branches,
  );

  return { guard, reads };
}

const branch = (id: string, businessId: string, is_active = true) =>
  ({ id, businessId, is_active }) as Branch;

const crew = { businessId: CARRIER, vehicleId: VEHICLE, driverId: DRIVER };

const SENTENCE =
  "O checklist desta empresa exige filial: defina a filial do veículo RBR4E21 ou do motorista Rita Barros.";

beforeEach(() => {
  modules.fleet = true;
  modules.asked = 0;
});

describe("the route's record branch, checked at the release", () => {
  it("refuses with 409 ROUTE_BRANCH_REQUIRED, naming the plate and the driver, when nothing resolves", async () => {
    for (const requirement of [
      "ROUTE_START",
      "ROUTE_END",
      "ROUTE_START_AND_END",
    ] as const) {
      const { guard } = guardFor({
        requirement,
        vehicleBranchId: null,
        driverBranchId: null,
        // Two active branches: no single one to fall back on.
        branches: [
          branch(HEAD_OFFICE, CARRIER),
          branch(SECOND_BRANCH, CARRIER),
        ],
      });

      await expect(guard.assertResolvable(crew)).rejects.toMatchObject({
        statusCode: 409,
        code: "ROUTE_BRANCH_REQUIRED",
        message: SENTENCE,
      });
    }
  });

  it("never counts another company's only branch", async () => {
    const { guard } = guardFor({
      requirement: "ROUTE_START",
      vehicleBranchId: null,
      driverBranchId: null,
      branches: [branch(FOREIGN_BRANCH, OTHER)],
    });

    await expect(guard.assertResolvable(crew)).rejects.toMatchObject({
      code: "ROUTE_BRANCH_REQUIRED",
    });
  });

  it("passes when the vehicle, the driver or the company's single active branch names one", async () => {
    // Two active branches: only the one the vehicle or the driver names can
    // explain the pass (the rows exist, as the foreign key guarantees).
    const twoActive = [
      branch(HEAD_OFFICE, CARRIER),
      branch(SECOND_BRANCH, CARRIER),
    ];
    const worlds: World[] = [
      {
        requirement: "ROUTE_START",
        vehicleBranchId: HEAD_OFFICE,
        driverBranchId: null,
        branches: twoActive,
      },
      {
        requirement: "ROUTE_START",
        vehicleBranchId: null,
        driverBranchId: HEAD_OFFICE,
        branches: twoActive,
      },
      {
        requirement: "ROUTE_END",
        vehicleBranchId: null,
        driverBranchId: null,
        branches: [
          branch(HEAD_OFFICE, CARRIER),
          branch(SECOND_BRANCH, CARRIER, false),
        ],
      },
    ];

    for (const world of worlds) {
      await expect(
        guardFor(world).guard.assertResolvable(crew),
      ).resolves.toBeUndefined();
    }
  });

  it("asks nothing more of a company that does not require the checklist", async () => {
    for (const requirement of ["NONE", null] as const) {
      const { guard, reads } = guardFor({
        requirement,
        vehicleBranchId: null,
        driverBranchId: null,
        branches: [],
      });

      await expect(guard.assertResolvable(crew)).resolves.toBeUndefined();
      expect(reads).toEqual({ vehicle: 0, driver: 0 });
    }

    expect(modules.asked).toBe(0);
  });

  it("falls through a vehicle or a driver branch that is inactive, as the driver's checklist does", async () => {
    // The driver's records resolve through ACTIVE branches only (wave 3.7):
    // an inactive vehicle branch falls through to the driver's, an inactive
    // driver branch to the company's single active one. Nothing to refuse.
    const worlds: World[] = [
      {
        requirement: "ROUTE_START",
        vehicleBranchId: SECOND_BRANCH,
        driverBranchId: HEAD_OFFICE,
        branches: [
          branch(HEAD_OFFICE, CARRIER),
          branch(SECOND_BRANCH, CARRIER, false),
        ],
      },
      {
        requirement: "ROUTE_START",
        vehicleBranchId: null,
        driverBranchId: SECOND_BRANCH,
        branches: [
          branch(HEAD_OFFICE, CARRIER),
          branch(SECOND_BRANCH, CARRIER, false),
        ],
      },
    ];

    for (const world of worlds) {
      await expect(
        guardFor(world).guard.assertResolvable(crew),
      ).resolves.toBeUndefined();
    }
  });

  it("names the inactive vehicle or driver branch when no active one is left to fall back on", async () => {
    // Two active branches besides the inactive one: no single fallback.
    const company = [
      { ...branch(HEAD_OFFICE, CARRIER), corporate_reason: "Matriz" },
      { ...branch(THIRD_BRANCH, CARRIER), corporate_reason: "Filial Sul" },
      {
        ...branch(SECOND_BRANCH, CARRIER, false),
        corporate_reason: "Filial Norte",
      },
    ];

    const onVehicle = guardFor({
      requirement: "ROUTE_START",
      vehicleBranchId: SECOND_BRANCH,
      driverBranchId: null,
      branches: company,
    });

    await expect(onVehicle.guard.assertResolvable(crew)).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_BRANCH_REQUIRED",
      message:
        "O checklist desta empresa exige filial ativa: a filial Filial Norte do veículo RBR4E21 está inativa. Reative a filial ou troque a filial do veículo.",
    });

    const onDriver = guardFor({
      requirement: "ROUTE_START",
      vehicleBranchId: null,
      driverBranchId: SECOND_BRANCH,
      branches: company,
    });

    await expect(onDriver.guard.assertResolvable(crew)).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_BRANCH_REQUIRED",
      message:
        "O checklist desta empresa exige filial ativa: a filial Filial Norte do motorista Rita Barros está inativa. Reative a filial ou troque a filial do motorista.",
    });
  });

  it("never names another company's branch as the inactive one", async () => {
    const { guard } = guardFor({
      requirement: "ROUTE_START",
      vehicleBranchId: FOREIGN_BRANCH,
      driverBranchId: null,
      branches: [
        branch(HEAD_OFFICE, CARRIER),
        branch(THIRD_BRANCH, CARRIER),
        {
          ...branch(FOREIGN_BRANCH, OTHER, false),
          corporate_reason: "Filial Alheia",
        },
      ],
    });

    await expect(guard.assertResolvable(crew)).rejects.toMatchObject({
      code: "ROUTE_BRANCH_REQUIRED",
      message: SENTENCE,
    });
  });

  it("passes when the fleet module is off: the checklist is not asked then (M6)", async () => {
    modules.fleet = false;

    const { guard } = guardFor({
      requirement: "ROUTE_START",
      vehicleBranchId: null,
      driverBranchId: null,
      branches: [],
    });

    await expect(guard.assertResolvable(crew)).resolves.toBeUndefined();
    expect(modules.asked).toBe(1);
  });
});
