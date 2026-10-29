import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { ODOMETER_UNIT_KEY } from "@/shared/ai/ai-rules";
import { OutboxService } from "@/shared/notifications/outbox-service";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import {
  FakeProviderError,
  fakeAnalyzer,
  resetCircuit,
} from "./support/fake-vision";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Contract §11 (provider outage): retries spread with jitter.
 *
 * The AI pipeline retried on the fixed schedule 30 s / 2 min / 10 min. A
 * local OCR outage fails every request of a claim pool within the same
 * second, and all of them — across every replica — came back due at the
 * same +30 s, hitting the recovering service as one burst. Now each delay is
 * spread by +/-20%, as the notification pipeline does.
 *
 * Real service, real queue table, the provider faked to time out (the seam
 * ai-pipeline-lifecycle.test.ts uses). Batches of four stay under the
 * circuit breaker's five consecutive failures, so every row takes the retry
 * path rather than the circuit's.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = createPrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  runCycle: () => Promise<void>;
};

const FLEET = "018fe950-0000-7000-8000-00000000000f";

let fleet: FleetDriverSeed;
let periodId = "";

async function queueFuel(): Promise<string> {
  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 1000,
      liters_amount: 50,
      price_per_liter: 6,
      total_amount: 300,
      odometer_photo: `odometerPhotos/${FLEET}/${randomUUID()}.jpg`,
      odometer_ai_status: "pending",
      businessId: FLEET,
      branchId: fleet.branchId,
      vehicleId: fleet.vehicleId,
      driverId: fleet.driverId,
      fuelTypeId: fleet.fuelTypeId,
    },
  });

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "FUEL_ODOMETER",
      recordId: fuel.id,
      businessId: FLEET,
      periodId,
      requestedById: fleet.driverUserId,
      input: { odometerPhotoPath: fuel.odometer_photo, reportedMileage: 1000 },
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: ODOMETER_UNIT_KEY },
  });

  return request.id;
}

beforeAll(async () => {
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "62777555000108",
  });

  periodId = (
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: FLEET,
        periodStart: quotaPeriodFor(new Date(), null).periodStart,
        reservedUnits: 100,
      },
    })
  ).id;
}, 60_000);

beforeEach(async () => {
  resetCircuit(pipeline);

  await prisma.aIAnalysisRequest.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "COMPLETED", leaseExpiresAt: null },
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("an OCR outage failing a claim pool at once", () => {
  it("schedules the retries spread over +/-20% of the 30 s step, not as one burst", async () => {
    pipeline.provider = fakeAnalyzer({
      analyzeOdometerImage: async () => {
        throw new FakeProviderError(undefined, "Request timed out.");
      },
    });

    const offsets: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      resetCircuit(pipeline);

      const ids = await Promise.all(
        Array.from({ length: 4 }, () => queueFuel()),
      );
      const failedAt = Date.now();

      await pipeline.runCycle();

      const cycleMs = Date.now() - failedAt;
      const rows = await prisma.aIAnalysisRequest.findMany({
        where: { id: { in: ids } },
      });

      expect(rows.map((row) => `${row.status}:${row.attempts}`)).toEqual(
        Array(4).fill("PENDING:1"),
      );

      for (const row of rows) {
        const offset = row.availableAt.getTime() - failedAt;

        // Inside the jitter window of the first step (plus the cycle's own
        // duration, since each row failed somewhere inside it).
        expect(offset).toBeGreaterThanOrEqual(24_000);
        expect(offset).toBeLessThanOrEqual(36_000 + cycleMs);

        offsets.push(offset);
      }

      // Out of the way of the next round.
      await prisma.aIAnalysisRequest.updateMany({
        where: { id: { in: ids } },
        data: { status: "COMPLETED", leaseExpiresAt: null },
      });
    }

    // Twelve rows that failed within a few hundred milliseconds of their
    // round's start. Without jitter they were due within the same ~second;
    // spread uniformly over 12 s, twelve of them landing inside 3 s has a
    // probability around 1e-6.
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThanOrEqual(
      3_000,
    );
  });
});
