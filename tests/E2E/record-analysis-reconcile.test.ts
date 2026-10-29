import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

// The sweep does nothing without a reader (dev), which is right: the request
// would only be marked unavailable. Here the reader "exists"; the pipeline
// is never woken, so nothing is ever read.
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

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { reconcileRecordAnalysisJob } from "@/jobs/cron/reconcile-record-analysis-job";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * A fuelling or a checklist whose AI reading was never requested.
 *
 * Both ask for the reading after their commit, fire-and-forget: a crash, a
 * deploy or a pool timeout in between left the record "pending" for good,
 * and the app's resend cannot heal it (a known submission returns before any
 * side effect). The proof had a sweep for exactly this (IDEMP-08); these two
 * did not. The sweep asks again with the input the manual button would send.
 */
const prisma = createPrismaClient();

const WITH_AI = "018fdc90-0000-7000-8000-00000000000a";
const WITHOUT_AI = "018fdc90-0000-7000-8000-00000000000b";

const MINUTE = 60 * 1000;

let withAI: FleetDriverSeed;
let withoutAI: FleetDriverSeed;

let mileage = 10_000;

async function fuel(
  seed: FleetDriverSeed,
  ageMs: number,
  overrides: Record<string, unknown> = {},
) {
  mileage += 100;

  return prisma.fuel.create({
    data: {
      current_mileage: mileage,
      liters_amount: 100,
      price_per_liter: 6,
      total_amount: 600,
      odometer_photo: `odometerPhotos/${seed.businessId}/${randomUUID()}.jpg`,
      businessId: seed.businessId,
      branchId: seed.branchId,
      vehicleId: seed.vehicleId,
      driverId: seed.driverId,
      fuelTypeId: seed.fuelTypeId,
      created_at: new Date(Date.now() - ageMs),
      ...overrides,
    },
  });
}

async function checklist(
  seed: FleetDriverSeed,
  ageMs: number,
  photosByField?: Record<string, string[]>,
) {
  const photo = `checklistPhotos/${seed.businessId}/${randomUUID()}.jpg`;

  return prisma.vehicleChecklist.create({
    data: {
      current_mileage: 12_345,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      photos: [photo],
      photos_by_field: photosByField ?? { current_mileage: [photo] },
      overall_condition: "approved",
      businessId: seed.businessId,
      branchId: seed.branchId,
      vehicleId: seed.vehicleId,
      driverId: seed.driverId,
      created_at: new Date(Date.now() - ageMs),
    },
  });
}

/** Records the sweep asked for, without reaching the quota or a reader. */
async function sweepWithSpy() {
  const requestAnalysis = vi
    .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
    .mockResolvedValue("queued");

  try {
    await reconcileRecordAnalysisJob.handler();

    return requestAnalysis.mock.calls.map(([call]) => call);
  } finally {
    requestAnalysis.mockRestore();
  }
}

beforeAll(async () => {
  withAI = await seedFleetDriver(prisma, {
    businessId: WITH_AI,
    cnpj: "61888444000190",
  });
  withoutAI = await seedFleetDriver(prisma, {
    businessId: WITHOUT_AI,
    cnpj: "61888555000190",
  });

  await prisma.business.update({
    where: { id: WITH_AI },
    data: { ai_analysis_limit: 10 },
  });

  // The company was already reading three days ago: its first quota period
  // opened then.
  await prisma.aIUsagePeriod.create({
    data: {
      businessId: WITH_AI,
      periodStart: new Date("2026-09-01"),
      created_at: new Date(Date.now() - 3 * 24 * 60 * MINUTE),
    },
  });

  vi.spyOn(AIAnalysisPipelineService.getInstance(), "wake").mockImplementation(
    () => undefined,
  );
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("the fuel and checklist reading sweep", () => {
  it("asks again for a fuelling left without a request, with the button's input", async () => {
    const lost = await fuel(withAI, 20 * MINUTE);

    const calls = await sweepWithSpy();
    const call = calls.find((request) => request.recordId === lost.id);

    expect(call).toEqual({
      type: "FUEL_ODOMETER",
      recordId: lost.id,
      businessId: WITH_AI,
      // The driver who sent it, from their login.
      requestedById: withAI.driverUserId,
      input: {
        odometerPhotoPath: lost.odometer_photo,
        reportedMileage: lost.current_mileage,
      },
    });
  });

  it("asks again for a checklist left without a request", async () => {
    const lost = await checklist(withAI, 20 * MINUTE);

    const calls = await sweepWithSpy();
    const call = calls.find((request) => request.recordId === lost.id);

    expect(call).toMatchObject({
      type: "CHECKLIST",
      recordId: lost.id,
      businessId: WITH_AI,
      requestedById: withAI.driverUserId,
      input: {
        photosByField: lost.photos_by_field,
        checklistData: expect.objectContaining({
          id: lost.id,
          current_mileage: 12_345,
        }),
      },
    });
  });

  it("leaves alone what is not a lost request", async () => {
    const period = await prisma.aIUsagePeriod.findFirstOrThrow({
      where: { businessId: WITH_AI },
    });

    // Already asked: the pipeline owns it, whatever its status.
    const asked = await fuel(withAI, 20 * MINUTE);
    await prisma.aIAnalysisRequest.create({
      data: {
        periodId: period.id,
        idempotencyKey: `test-${randomUUID()}`,
        type: "FUEL_ODOMETER",
        recordId: asked.id,
        businessId: WITH_AI,
        requestedById: withAI.driverUserId,
        input: { odometerPhotoPath: asked.odometer_photo },
        status: "SKIPPED",
        completedAt: new Date(),
      },
    });

    // Too fresh: its own post-commit request may still be on its way.
    const fresh = await fuel(withAI, 1 * MINUTE);

    // Too old: a reading nobody acts on any more.
    const stale = await fuel(withAI, 3 * 24 * 60 * MINUTE);

    // Already has a verdict.
    const verified = await fuel(withAI, 20 * MINUTE, {
      odometer_ai_status: "verified",
    });

    // The company did not buy the reading.
    const unpaid = await fuel(withoutAI, 20 * MINUTE);

    const recordIds = (await sweepWithSpy()).map((call) => call.recordId);

    for (const record of [asked, fresh, stale, verified, unpaid]) {
      expect(recordIds).not.toContain(record.id);
    }
  });

  it("does not spend fresh quota on records made before the company switched the reading on", async () => {
    // Switched on just now: its first period opens after the record.
    const lateStarter = await seedFleetDriver(prisma, {
      businessId: "018fdc90-0000-7000-8000-00000000000c",
      cnpj: "61888666000190",
    });

    await prisma.business.update({
      where: { id: lateStarter.businessId },
      data: { ai_analysis_limit: 10 },
    });

    const before = await fuel(lateStarter, 30 * MINUTE);

    await prisma.aIUsagePeriod.create({
      data: {
        businessId: lateStarter.businessId,
        periodStart: new Date("2026-10-01"),
      },
    });

    const recordIds = (await sweepWithSpy()).map((call) => call.recordId);

    expect(recordIds).not.toContain(before.id);
  });

  it("does not spend quota on records made while the reading was switched off", async () => {
    // Reading for months, switched off, then on again 15 minutes ago. The
    // fuelling from 30 minutes ago was made while it was off; the period
    // from months back would have let it through on its own.
    const switchedBack = await seedFleetDriver(prisma, {
      businessId: "018fdc90-0000-7000-8000-00000000000d",
      cnpj: "61888777000190",
    });

    await prisma.business.update({
      where: { id: switchedBack.businessId },
      data: { ai_analysis_limit: 10 },
    });

    await prisma.aIUsagePeriod.create({
      data: {
        businessId: switchedBack.businessId,
        periodStart: new Date("2026-08-01"),
        created_at: new Date(Date.now() - 60 * 24 * 60 * MINUTE),
      },
    });

    const whileOff = await fuel(switchedBack, 30 * MINUTE);
    const afterwards = await fuel(switchedBack, 12 * MINUTE);

    // What update-ai-limit publishes with the switch (OUTBOX-10).
    await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `business-limit.changed:${switchedBack.businessId}:${randomUUID()}`,
        topic: "business-limit.changed",
        aggregateType: "business",
        aggregateId: switchedBack.businessId,
        businessId: switchedBack.businessId,
        payload: {
          businessId: switchedBack.businessId,
          businessName: "Transportadora",
          limit: "ai",
          previousValue: 0,
          newValue: 10,
        },
        status: "PUBLISHED",
        processedAt: new Date(),
        created_at: new Date(Date.now() - 15 * MINUTE),
      },
    });

    const recordIds = (await sweepWithSpy()).map((call) => call.recordId);

    expect(recordIds).not.toContain(whileOff.id);

    // Made after the switch: a lost request like any other.
    expect(recordIds).toContain(afterwards.id);
  });

  // A checklist whose field lists are all empty has nothing to read: the
  // service answers "unavailable" and leaves it pending, so the sweep picked
  // it again every 10 minutes for two days, holding its company's slots.
  it("leaves out a checklist with no photo the service could read", async () => {
    const photo = `checklistPhotos/${WITH_AI}/${randomUUID()}.jpg`;

    const empty = await checklist(withAI, 20 * MINUTE, {
      current_mileage: [],
      tires_condition: [""],
    });
    const oneReadable = await checklist(withAI, 20 * MINUTE, {
      tires_condition: [],
      current_mileage: [photo],
    });

    const recordIds = (await sweepWithSpy()).map((call) => call.recordId);

    expect(recordIds).not.toContain(empty.id);
    expect(recordIds).toContain(oneReadable.id);
  });

  // Without an order the run's cut fell wherever the scan put it, company
  // by company, and the same few companies could fill every run.
  it("takes the oldest records first across companies", async () => {
    const other = await seedFleetDriver(prisma, {
      businessId: "018fdc90-0000-7000-8000-00000000000e",
      cnpj: "61888888000190",
    });

    await prisma.business.update({
      where: { id: other.businessId },
      data: { ai_analysis_limit: 10 },
    });
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: other.businessId,
        periodStart: new Date("2026-09-01"),
        created_at: new Date(Date.now() - 3 * 24 * 60 * MINUTE),
      },
    });

    const expected = [
      await fuel(withAI, 50 * MINUTE),
      await fuel(other, 40 * MINUTE),
      await fuel(withAI, 30 * MINUTE),
      await fuel(other, 20 * MINUTE),
    ].map((record) => record.id);

    const recordIds = (await sweepWithSpy())
      .map((call) => call.recordId)
      .filter((id) => expected.includes(id));

    expect(recordIds).toEqual(expected);
  });

  it("asks once: the request it opens takes the record out of the next run", async () => {
    const lost = await fuel(withAI, 20 * MINUTE);

    // The real request this time (quota and idempotency key), pipeline asleep.
    await reconcileRecordAnalysisJob.handler();
    await reconcileRecordAnalysisJob.handler();

    const requests = await prisma.aIAnalysisRequest.findMany({
      where: { type: "FUEL_ODOMETER", recordId: lost.id },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("PENDING");
  });
});
