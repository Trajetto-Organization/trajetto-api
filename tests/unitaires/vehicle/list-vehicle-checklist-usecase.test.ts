import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { VehicleChecklist } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";
import type { UploadService } from "@/shared/services/upload-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import { ListVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/list-vehicle-checklist-usecase";

/**
 * The checklist list (TEST-UC-1): one company, a driver sees only their own
 * inspections (decision 4.4), and every stored photo path leaves signed.
 * Storage signing is the replaced boundary.
 */
const CARRIER = "018f3700-0000-7000-8000-00000000000a";
const OTHER = "018f3700-0000-7000-8000-00000000000b";

const ADMIN = "018f3700-0000-7000-8000-0000000000a1";
const MASTER = "018f3700-0000-7000-8000-0000000000a3";
const DRIVER_USER = "018f3700-0000-7000-8000-0000000000a4";
const UNKNOWN = "018f3700-0000-7000-8000-0000000000ff";

const DRIVER = "018f3700-0000-7000-8000-0000000000d1";
const COLLEAGUE = "018f3700-0000-7000-8000-0000000000d2";

let users: InMemoryUserRepository;
let checklists: InMemoryVehicleChecklistRepository;

const uploads = {
  getFileUrl: vi.fn(async (path: string) => `https://cdn.test/${path}?signed`),
} as unknown as UploadService;

const checklistOf = (
  id: string,
  businessId: string,
  driverId: string,
  createdAt: string,
  overrides: Partial<VehicleChecklist> = {},
): VehicleChecklist =>
  ({
    id,
    businessId,
    driverId,
    vehicleId: "vehicle-1",
    branchId: "branch-1",
    overall_condition: "approved",
    photos: [],
    photos_by_field: {},
    notes: null,
    checklist_date: createdAt,
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
    ...overrides,
  }) as unknown as VehicleChecklist;

beforeEach(() => {
  users = new InMemoryUserRepository();
  checklists = new InMemoryVehicleChecklistRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
    } as User,
  );

  checklists.checklists.push(
    checklistOf(
      "018f3700-0000-7000-8000-000000000001",
      CARRIER,
      DRIVER,
      "2026-09-01T12:00:00Z",
      {
        photos: ["checklists/a/frente.jpg"],
        photos_by_field: { pneus: ["checklists/a/pneu.jpg"] },
      } as Partial<VehicleChecklist>,
    ),
    checklistOf(
      "018f3700-0000-7000-8000-000000000002",
      CARRIER,
      COLLEAGUE,
      "2026-09-02T12:00:00Z",
      {
        overall_condition: "rejected",
      } as Partial<VehicleChecklist>,
    ),
    checklistOf(
      "018f3700-0000-7000-8000-000000000003",
      OTHER,
      "driver-x",
      "2026-09-03T12:00:00Z",
    ),
  );
});

const list = () => new ListVehicleChecklistUseCase(checklists, users, uploads);

describe("the vehicle checklist list", () => {
  it("answers the manager every checklist of the company, newest first", async () => {
    const result = await list().execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.id)).toEqual([
      "018f3700-0000-7000-8000-000000000002",
      "018f3700-0000-7000-8000-000000000001",
    ]);
    expect(result.total).toBe(2);
  });

  it("answers a driver only their own checklists", async () => {
    const result = await list().execute({
      userId: DRIVER_USER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.driverId)).toEqual([DRIVER]);
    expect(result.total).toBe(1);
  });

  it("signs every photo, the flat list and the per-field one", async () => {
    const result = await list().execute({
      userId: DRIVER_USER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data[0].photos).toEqual([
      "https://cdn.test/checklists/a/frente.jpg?signed",
    ]);
    expect(result.data[0].photos_by_field).toEqual({
      pneus: ["https://cdn.test/checklists/a/pneu.jpg?signed"],
    });
  });

  it("filters by condition over the company", async () => {
    const result = await list().execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      conditions: ["rejected"],
    });

    expect(result.data.map((row) => row.id)).toEqual([
      "018f3700-0000-7000-8000-000000000002",
    ]);
  });

  it("refuses a company user naming another company (403)", async () => {
    await expect(
      list().execute({
        userId: ADMIN,
        businessId: OTHER,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("asks the MASTER for a company (400), then serves the picked one", async () => {
    await expect(
      list().execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const result = await list().execute({
      userId: MASTER,
      businessId: OTHER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.businessId)).toEqual([OTHER]);
  });

  it("refuses an unknown caller (404) and turns a signing failure into a 500", async () => {
    await expect(
      list().execute({ userId: UNKNOWN, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404 });

    vi.mocked(uploads.getFileUrl).mockRejectedValueOnce(
      new Error("signing failed"),
    );

    await expect(
      list().execute({ userId: DRIVER_USER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
