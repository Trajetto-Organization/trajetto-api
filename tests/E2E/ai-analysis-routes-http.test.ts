import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

// The provider is "configured" so requests reach the queue; the pipeline's
// wake is stubbed below, so nothing is ever sent to it.
vi.mock("@/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/env")>();

  return {
    ...original,
    env: {
      ...original.env,
      AI_PROVIDER: "local",
      AI_LOCAL_URL: "http://127.0.0.1:9",
      AI_LOCAL_TOKEN: "t".repeat(40),
    },
  };
});

import auth from "@/config/auth";
import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";

import { fakeVision } from "./support/fake-vision";
import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The AI routes over real HTTP (AI-1, AI-2, decisions 4.1 and 4.3).
 *
 * They checked only that somebody was logged in: a read-only user or a
 * driver could start paid analyses on any record of the company, with the
 * FLEET module switched off too; the progress of a colleague's record was
 * readable by any driver; and the checklist's manual request, built from the
 * whole database row, paid for every photo again after each analysis.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdcb0-0000-7000-8000-00000000000a";
const OTHER = "018fdcb0-0000-7000-8000-00000000000b";
const NO_FLEET = "018fdcb0-0000-7000-8000-00000000000c";

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

const tokens: Record<
  "reader" | "writer" | "colleagueDriver" | "master" | "noFleetAdmin",
  string
> = {} as never;

let noFleetFuelId = "";

async function sessionFor(
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuária",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

async function profile(businessId: string, canWrite: boolean): Promise<string> {
  const created = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: ["fuel_manage", "vehicle_checklist_manage"].map((key) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite,
          businessId,
        })),
      },
    },
  });

  return created.id;
}

async function fuelOf(
  seed: FleetDriverSeed,
  overrides: { driverId?: string } = {},
): Promise<string> {
  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 1000,
      liters_amount: 50,
      price_per_liter: 6,
      total_amount: 300,
      odometer_photo: `odometerPhotos/${seed.businessId}/${randomUUID()}.jpg`,
      odometer_ai_status: "skipped",
      businessId: seed.businessId,
      branchId: seed.branchId,
      vehicleId: seed.vehicleId,
      driverId: overrides.driverId ?? seed.driverId,
      fuelTypeId: seed.fuelTypeId,
    },
  });

  return fuel.id;
}

function call(method: "GET" | "POST", url: string, token: string) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  vi.spyOn(AIAnalysisPipelineService.prototype, "wake").mockImplementation(
    () => undefined,
  );

  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "62777666000190",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "62777666000271",
  });

  await prisma.business.updateMany({
    where: { id: { in: [CARRIER, OTHER] } },
    data: { ai_analysis_limit: 10 },
  });

  tokens.reader = await sessionFor(CARRIER, "BUSINESS_USER", {
    profileAccessId: await profile(CARRIER, false),
  });
  tokens.writer = await sessionFor(CARRIER, "BUSINESS_USER", {
    profileAccessId: await profile(CARRIER, true),
  });

  // A second driver of the same company.
  const colleague = await prisma.driver.create({
    data: {
      name: "Colega",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
      branchId: carrier.branchId,
    },
  });

  tokens.colleagueDriver = await sessionFor(CARRIER, "BUSINESS_USER", {
    driverId: colleague.id,
  });

  tokens.master = await sessionFor(null, "MASTER");

  // A company that hired only Entregas, with AI quota.
  await prisma.business.create({
    data: {
      id: NO_FLEET,
      corporate_reason: "Só Entregas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "62777666000352",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `so-entregas-${randomUUID()}@exemplo.com.br`,
      ai_analysis_limit: 10,
    },
  });
  await prisma.businessEntitlement.create({
    data: { businessId: NO_FLEET, module: "DELIVERIES", enabled: true },
  });
  tokens.noFleetAdmin = await sessionFor(NO_FLEET, "BUSINESS_ADMIN");

  // A fuelling left over from when it had FLEET.
  noFleetFuelId = (
    await prisma.fuel.create({
      data: {
        current_mileage: 1,
        liters_amount: 1,
        price_per_liter: 1,
        total_amount: 1,
        odometer_photo: "odometerPhotos/x.jpg",
        businessId: NO_FLEET,
        branchId: other.branchId,
        vehicleId: other.vehicleId,
        driverId: other.driverId,
        fuelTypeId: other.fuelTypeId,
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await prisma.$disconnect();
});

describe("asking for a reading (POST /ai-analysis/request)", () => {
  it("is refused to a driver, and nothing is queued", async () => {
    const fuelId = await fuelOf(carrier);

    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${fuelId}`,
      carrier.driverToken,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
    expect(
      await prisma.aIAnalysisRequest.count({ where: { recordId: fuelId } }),
    ).toBe(0);
  });

  it("is refused to a read-only profile", async () => {
    const fuelId = await fuelOf(carrier);

    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${fuelId}`,
      tokens.reader,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("is refused to a company without the fleet module", async () => {
    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${noFleetFuelId}`,
      tokens.noFleetAdmin,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("is refused to the MASTER on a record of a company without the fleet module", async () => {
    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${noFleetFuelId}`,
      tokens.master,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("answers another company's record as one that does not exist", async () => {
    const foreign = await fuelOf(other);

    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${foreign}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe("AI_RECORD_NOT_FOUND");
    expect(
      await prisma.aIAnalysisRequest.count({ where: { recordId: foreign } }),
    ).toBe(0);
  });

  it("queues it for a profile that writes the record, once", async () => {
    const fuelId = await fuelOf(carrier);

    const first = await call(
      "POST",
      `/ai-analysis/request/fuel/${fuelId}`,
      tokens.writer,
    );

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().outcome).toBe("queued");

    const again = await call(
      "POST",
      `/ai-analysis/request/fuel/${fuelId}`,
      tokens.writer,
    );

    expect(again.json().outcome).toBe("already_running");
    expect(
      await prisma.aIAnalysisRequest.count({ where: { recordId: fuelId } }),
    ).toBe(1);
  });

  it("lets the MASTER ask on a company that has the fleet module", async () => {
    const fuelId = await fuelOf(carrier);

    const response = await call(
      "POST",
      `/ai-analysis/request/fuel/${fuelId}`,
      tokens.master,
    );

    expect(response.statusCode, response.body).toBe(200);
  });

  it("says so, with a code, when the company has the readings off", async () => {
    const fuelId = await fuelOf(other);

    await prisma.business.update({
      where: { id: OTHER },
      data: { ai_analysis_limit: 0 },
    });

    try {
      const response = await call(
        "POST",
        `/ai-analysis/request/fuel/${fuelId}`,
        other.managerToken,
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("AI_NOT_ENABLED");
    } finally {
      await prisma.business.update({
        where: { id: OTHER },
        data: { ai_analysis_limit: 10 },
      });
    }
  });
});

/** The pipeline's analyzer, swapped for a describe and put back. */
function pipelineAnalyzer() {
  return AIAnalysisPipelineService.getInstance() as unknown as {
    provider: unknown;
  };
}

describe("the checklist's manual reading (AI-2)", () => {
  // These cases are about which PHOTOS a request takes, with a reader that
  // reads every kind (a vision model). What the OCR reader covers is below.
  let saved: unknown;

  beforeAll(() => {
    saved = pipelineAnalyzer().provider;
    pipelineAnalyzer().provider = fakeVision(() => "{}");
  });

  afterAll(() => {
    pipelineAnalyzer().provider = saved;
  });

  async function checklistWithPhotos() {
    return prisma.vehicleChecklist.create({
      data: {
        current_mileage: 1000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        fuel_level_adequate: true,
        photos_by_field: {
          current_mileage: ["km.jpg"],
          tires_condition: ["pneu.jpg"],
          fuel_level_adequate: ["tanque.jpg"],
        },
        ai_verification_status: "skipped",
        businessId: CARRIER,
        branchId: carrier.branchId,
        vehicleId: carrier.vehicleId,
        driverId: carrier.driverId,
      },
    });
  }

  /** What the pipeline leaves when it reads every unit of a request. */
  async function finishEverything(checklistId: string) {
    const requests = await prisma.aIAnalysisRequest.findMany({
      where: { recordId: checklistId },
    });

    for (const request of requests) {
      await prisma.aIAnalysisUnit.updateMany({
        where: { requestId: request.id },
        data: { status: "CONSUMED", consumedAt: new Date() },
      });
      await prisma.aIAnalysisRequest.update({
        where: { id: request.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }

    // The verdict columns change with the result.
    await prisma.vehicleChecklist.update({
      where: { id: checklistId },
      data: {
        ai_verification_status: "verified",
        ai_verification_details: { tires_condition: { status: "confirmed" } },
        ai_verified_at: new Date(),
      },
    });
  }

  // Red on the old code: the input was the whole row, so the verdict columns
  // changed the key and the second click queued — and paid for — all three
  // photos again.
  it("does not pay again for photos already read", async () => {
    const checklist = await checklistWithPhotos();

    const first = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(first.json().outcome).toBe("queued");
    expect(
      await prisma.aIAnalysisUnit.count({
        where: { request: { recordId: checklist.id } },
      }),
    ).toBe(3);

    await finishEverything(checklist.id);

    const again = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().outcome).toBe("already_completed");
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(1);
  });

  it("reads only the photo that changed since", async () => {
    const checklist = await checklistWithPhotos();

    await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );
    await finishEverything(checklist.id);

    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: {
        photos_by_field: {
          current_mileage: ["km.jpg"],
          tires_condition: ["pneu-novo.jpg"],
          fuel_level_adequate: ["tanque.jpg"],
        },
      },
    });

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(response.json().outcome).toBe("queued");

    const newest = await prisma.aIAnalysisRequest.findFirstOrThrow({
      where: { recordId: checklist.id, status: "PENDING" },
      include: { units: true },
    });

    expect(newest.units.map((unit) => unit.unitKey)).toEqual([
      "tires_condition",
    ]);
    expect(newest.input).toEqual({
      photosByField: { tires_condition: ["pneu-novo.jpg"] },
      checklistData: { tires_condition: "good" },
    });
  });

  // Red before: only a CONSUMED unit counted as read, so the photo an update
  // had just queued — still waiting behind a backlog or a paused provider —
  // was reserved and paid for a second time by the button.
  it("does not buy again a photo another request is about to read", async () => {
    // Room in the quota: the earlier cases spent most of the 10.
    await prisma.business.update({
      where: { id: CARRIER },
      data: { ai_analysis_limit: 100 },
    });

    const checklist = await checklistWithPhotos();

    await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );
    await finishEverything(checklist.id);

    // The driver replaced two photos; the update queued only the tyres'.
    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: {
        photos_by_field: {
          current_mileage: ["km.jpg"],
          tires_condition: ["pneu-trocado.jpg"],
          fuel_level_adequate: ["tanque-trocado.jpg"],
        },
        ai_verification_status: "skipped",
      },
    });

    await AIAnalysisService.getInstance().requestAnalysis({
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: CARRIER,
      requestedById: carrier.driverUserId,
      input: {
        photosByField: { tires_condition: ["pneu-trocado.jpg"] },
        checklistData: { tires_condition: "good" },
      },
    });

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcome).toBe("queued");

    const inFlight = await prisma.aIAnalysisRequest.findMany({
      where: { recordId: checklist.id, status: "PENDING" },
      include: { units: true },
      orderBy: { created_at: "asc" },
    });

    // The button asked only for the photo nobody was reading.
    expect(
      inFlight.map((request) => request.units.map((unit) => unit.unitKey)),
    ).toEqual([["tires_condition"], ["fuel_level_adequate"]]);

    // Everything left is being read: nothing new, nothing reserved again.
    const again = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().outcome).toBe("already_running");
    expect(
      await prisma.aIAnalysisUnit.count({
        where: {
          unitKey: "tires_condition",
          request: { recordId: checklist.id, status: "PENDING" },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(3);
  });
});

describe("a checklist under the local OCR reader (ADR 0010 §5)", () => {
  async function checklistWith(photos: Record<string, string[]>) {
    return prisma.vehicleChecklist.create({
      data: {
        current_mileage: 1000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        fuel_level_adequate: true,
        photos_by_field: photos,
        ai_verification_status: "skipped",
        businessId: CARRIER,
        branchId: carrier.branchId,
        vehicleId: carrier.vehicleId,
        driverId: carrier.driverId,
      },
    });
  }

  async function ledger() {
    const periods = await prisma.aIUsagePeriod.findMany({
      where: { businessId: CARRIER },
    });

    return periods.reduce(
      (sum, period) => ({
        reserved: sum.reserved + period.reservedUnits,
        consumed: sum.consumed + period.consumedUnits,
      }),
      { reserved: 0, consumed: 0 },
    );
  }

  beforeAll(async () => {
    await prisma.business.update({
      where: { id: CARRIER },
      data: { ai_analysis_limit: 1000 },
    });
  });

  // Red before: every photo was a unit, so the tyre and the fuel gauge were
  // reserved and charged for a reading OCR cannot give.
  it("reserves only the odometer: the tyre and the fuel gauge cost nothing", async () => {
    const checklist = await checklistWith({
      current_mileage: ["km.jpg"],
      tires_condition: ["pneu.jpg"],
      fuel_level_adequate: ["tanque.jpg"],
    });

    const before = await ledger();

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcome).toBe("queued");

    const request = await prisma.aIAnalysisRequest.findFirstOrThrow({
      where: { recordId: checklist.id },
      include: { units: true },
    });

    expect(request.units.map((unit) => unit.unitKey)).toEqual([
      "current_mileage",
    ]);
    expect(request.input).toEqual({
      photosByField: { current_mileage: ["km.jpg"] },
      checklistData: { current_mileage: 1000 },
    });
    expect(await ledger()).toEqual({
      reserved: before.reserved + 1,
      consumed: before.consumed,
    });
  });

  // Red before: three units reserved for photos nothing would ever read.
  it("answers 409 AI_NOT_COVERED with only uncovered photos, and reserves nothing", async () => {
    const checklist = await checklistWith({
      tires_condition: ["pneu.jpg"],
      fuel_level_adequate: ["tanque.jpg"],
    });

    const before = await ledger();

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("AI_NOT_COVERED");
    expect(response.headers["x-error-code"]).toBe("AI_NOT_COVERED");
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(0);
    expect(await ledger()).toEqual(before);
  });

  it("a checklist saved with only uncovered photos is marked not analysed, not left pending", async () => {
    const checklist = await checklistWith({ tires_condition: ["pneu.jpg"] });
    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: { ai_verification_status: "pending" },
    });

    const outcome = await AIAnalysisService.getInstance().requestAnalysis({
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: CARRIER,
      requestedById: carrier.driverUserId,
      input: {
        photosByField: { tires_condition: ["pneu.jpg"] },
        checklistData: { tires_condition: "good" },
      },
    });

    expect(outcome).toBe("not_covered");

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });
    expect(row.ai_verification_status).toBe("skipped");
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(0);
  });

  it("after the odometer was read, the uncovered photos left do not make the button promise a reading", async () => {
    const checklist = await checklistWith({
      current_mileage: ["km.jpg"],
      tires_condition: ["pneu.jpg"],
    });

    await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    const request = await prisma.aIAnalysisRequest.findFirstOrThrow({
      where: { recordId: checklist.id },
    });
    await prisma.aIAnalysisUnit.updateMany({
      where: { requestId: request.id },
      data: { status: "CONSUMED", consumedAt: new Date() },
    });
    await prisma.aIAnalysisRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const again = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().outcome).toBe("already_completed");
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(1);
  });

  it("refuses the same request from another company's manager as a missing record", async () => {
    const checklist = await checklistWith({ tires_condition: ["pneu.jpg"] });

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      other.managerToken,
    );

    expect(response.statusCode).toBe(404);
  });
});

describe("an informed value corrected after the reading (AI-2)", () => {
  // Red before: every photo was read, so the button answered
  // already_completed and the checklist kept "Não confere" for a condition
  // the manager had just corrected to what the photo shows.
  it("is compared again with the paid reading when the button is pressed, free", async () => {
    const checklist = await prisma.vehicleChecklist.create({
      data: {
        current_mileage: 1000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        fuel_level_adequate: true,
        photos_by_field: { bumpers_condition: ["para-choque.jpg"] },
        ai_verification_status: "issues_found",
        ai_verification_details: {
          bumpers_condition: {
            status: "contradicts",
            confidence: 0.9,
            observation: "amassado",
            observed: "bad",
            informed: "good",
            photosAnalyzed: 1,
          },
        },
        businessId: CARRIER,
        branchId: carrier.branchId,
        vehicleId: carrier.vehicleId,
        driverId: carrier.driverId,
      },
    });

    // The reading that was paid for, as the pipeline leaves it.
    const period = await prisma.aIUsagePeriod.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    const request = await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "CHECKLIST",
        recordId: checklist.id,
        businessId: CARRIER,
        periodId: period.id,
        requestedById: carrier.driverUserId,
        input: {
          photosByField: { bumpers_condition: ["para-choque.jpg"] },
          checklistData: { bumpers_condition: "good" },
        },
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    await prisma.aIAnalysisUnit.create({
      data: {
        requestId: request.id,
        unitKey: "bumpers_condition",
        status: "CONSUMED",
        consumedAt: new Date(),
        result: {
          status: "contradicts",
          confidence: 0.9,
          observation: "amassado",
          observed: "bad",
          informed: "good",
          photosAnalyzed: 1,
          rawResponse: {
            condicao_observada: "bad",
            confianca: 0.9,
            observacao: "amassado",
          },
        },
      },
    });

    // The manager agrees with the photo.
    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: { bumpers_condition: "bad" },
    });

    const response = await call(
      "POST",
      `/ai-analysis/request/checklist/${checklist.id}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcome).toBe("already_completed");

    const after = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(after.ai_verification_status).toBe("verified");
    expect(after.ai_verification_details).toMatchObject({
      bumpers_condition: {
        status: "confirmed",
        observed: "bad",
        informed: "bad",
      },
    });

    // Nothing new was queued or reserved.
    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: checklist.id },
      }),
    ).toBe(1);
  });
});

describe("watching a reading (GET /ai-analysis/progress)", () => {
  it("tells the screen whether this user may ask for a reading", async () => {
    const fuelId = await fuelOf(carrier);

    const admin = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      carrier.managerToken,
    );

    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().data).toMatchObject({
      status: "none",
      aiEnabled: true,
      canRequest: true,
    });

    const reader = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      tokens.reader,
    );

    expect(reader.json().data).toMatchObject({
      aiEnabled: true,
      canRequest: false,
    });

    // The driver who registered it may watch it, never ask.
    const driver = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      carrier.driverToken,
    );

    expect(driver.statusCode, driver.body).toBe(200);
    expect(driver.json().data.canRequest).toBe(false);
  });

  // Red on the old code: tenant-scoped only, so any driver of the company
  // read a colleague's counters and lastError.
  it("does not show a driver a colleague's record", async () => {
    const fuelId = await fuelOf(carrier);

    const response = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      tokens.colleagueDriver,
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe("AI_RECORD_NOT_FOUND");
  });

  it("answers another company's record as one that does not exist", async () => {
    const foreign = await fuelOf(other);

    const response = await call(
      "GET",
      `/ai-analysis/progress/fuel/${foreign}`,
      carrier.managerToken,
    );

    expect(response.statusCode, response.body).toBe(404);
  });

  it("is refused to a profile without the record's permission", async () => {
    const noFleetProfile = await sessionFor(CARRIER, "BUSINESS_USER", {
      profileAccessId: (
        await prisma.profileAccess.create({
          data: {
            name: `Só entregas ${randomUUID().slice(0, 6)}`,
            businessId: CARRIER,
            permissions: {
              create: [
                {
                  permissionKey: "delivery_manage",
                  action: "delivery_manage",
                  canRead: true,
                  canWrite: true,
                  businessId: CARRIER,
                },
              ],
            },
          },
        })
      ).id,
    });

    const fuelId = await fuelOf(carrier);

    const response = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      noFleetProfile,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });
});

describe("a reading that waits on the provider (AI-8)", () => {
  async function requestFor(
    fuelId: string,
    status: "PENDING" | "FAILED",
    lastError: string | null,
  ) {
    const period = await prisma.aIUsagePeriod.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    return prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "FUEL_ODOMETER",
        recordId: fuelId,
        businessId: CARRIER,
        periodId: period.id,
        requestedById: carrier.driverUserId,
        input: {},
        status,
        lastError,
        availableAt: new Date(Date.now() - 1_000),
      },
    });
  }

  // Red before: the raw lastError went out — the provider's own words, to
  // drivers too — and the web had to find the pause by its text's prefix,
  // while a request queued during the outage (lastError null) read as a
  // reading in progress.
  it("says so with a code, in our words, for the one refused and the ones queued behind it", async () => {
    const refusedFuel = await fuelOf(carrier);
    const refused = await requestFor(
      refusedFuel,
      "PENDING",
      "AI_PROVIDER_PAUSED: This request would exceed your organization's spend limit.",
    );

    const queuedFuel = await fuelOf(carrier);
    await requestFor(queuedFuel, "PENDING", null);

    try {
      for (const [fuelId, token] of [
        [refusedFuel, carrier.managerToken],
        [queuedFuel, carrier.managerToken],
        [refusedFuel, carrier.driverToken],
      ] as const) {
        const response = await call(
          "GET",
          `/ai-analysis/progress/fuel/${fuelId}`,
          token,
        );

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().data).toMatchObject({
          status: "PENDING",
          paused: true,
          lastErrorCode: "AI_PROVIDER_PAUSED",
          lastError:
            "O provedor de IA recusou o serviço; a leitura será retomada automaticamente.",
        });
        expect(response.body).not.toContain("spend limit");
      }
    } finally {
      await prisma.aIAnalysisRequest.update({
        where: { id: refused.id },
        data: { status: "COMPLETED", lastError: null },
      });
    }

    // The provider is back: the one still queued is an ordinary wait.
    const after = await call(
      "GET",
      `/ai-analysis/progress/fuel/${queuedFuel}`,
      carrier.managerToken,
    );

    expect(after.json().data).toMatchObject({
      paused: false,
      lastErrorCode: null,
    });
  });

  it("does not hand the provider's error text to the tenant when a reading failed", async () => {
    const fuelId = await fuelOf(carrier);

    await requestFor(
      fuelId,
      "FAILED",
      '401 {"type":"authentication_error","message":"invalid x-api-key"}',
    );

    const response = await call(
      "GET",
      `/ai-analysis/progress/fuel/${fuelId}`,
      carrier.managerToken,
    );

    expect(response.json().data).toMatchObject({
      status: "FAILED",
      paused: false,
      lastErrorCode: "AI_ANALYSIS_ERROR",
      lastError: "A leitura automática não pôde ser concluída.",
    });
    expect(response.body).not.toContain("x-api-key");
  });
});

describe("the published contract", () => {
  it("documents the module, the permission and every refusal", () => {
    const document = app.swagger() as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const post =
      document.paths["/ai-analysis/request/{recordType}/{recordId}"].post;
    const get =
      document.paths["/ai-analysis/progress/{recordType}/{recordId}"].get;

    expect(post["x-module"]).toBe("FLEET");
    expect(get["x-module"]).toBe("FLEET");

    expect(Object.keys(post.responses as object)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "409", "429"]),
    );

    // The pause and the reason are fields of the contract, not a prefix of
    // free text the client had to parse.
    const progress = (
      get.responses as Record<
        string,
        { content: Record<string, { schema: any }> }
      >
    )["200"].content["application/json"].schema.properties.data.properties;

    expect(progress.paused.type).toBe("boolean");
    expect(progress.lastErrorCode.enum).toEqual(
      expect.arrayContaining([
        "AI_PROVIDER_PAUSED",
        "AI_INPUT_SUPERSEDED",
        "AI_QUOTA_EXCEEDED",
      ]),
    );
  });
});
