import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { ODOMETER_UNIT_KEY } from "@/shared/ai/ai-rules";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { sendAIVerificationEvent } from "@/websocket";

import { seedProofCard } from "./support/proof-card-seed";
import { seedFleetDriver, type FleetDriverSeed } from "./support/fleet-driver-seed";
import { FakeProviderError, fakeAnalyzer, resetCircuit } from "./support/fake-vision";

/**
 * One AI analysis request from claim to settle, against the real service and
 * the real queue table, with the vision provider faked (TESTS-01, GAP2-2).
 *
 * ai-pipeline-lease.test.ts covers the pool, the stale owner's FAILURE and
 * the guard on a receipt. What nothing exercised end to end: a request that
 * finishes (the verdict on the record, the unit and the quota settled once),
 * a provider timeout going back to the queue with the backoff — and the
 * backoff being honoured —, the retry budget running out, the guard on the
 * records a person looks at (a fuel, a checklist), a stale owner whose call
 * SUCCEEDS after another replica took the request over, and the fair claim
 * with two companies that both have a backlog.
 *
 * The provider is swapped on the singleton and the cycle driven by hand, the
 * seam the other pipeline tests use; nothing here reaches the network.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = new PrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  runCycle: () => Promise<void>;
};

const FLEET = "018fdc50-0000-7000-8000-00000000000f";
const CARRIER_A = "018fdc50-0000-7000-8000-00000000000a";
const CARRIER_B = "018fdc50-0000-7000-8000-00000000000b";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const USAGE = {
  provider: "fake",
  model: "test",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
};

/** The model reading exactly what the driver typed. */
const READS_1000 = {
  parsed: {
    valor_lido: 1000,
    confianca: 0.95,
    legivel: true,
    sinais_fraude: false,
    motivos_fraude: [],
    observacao: "ok",
  },
  usage: USAGE,
};

/** The receipt, transcribed (decision 6.9). */
const PROOF_ANSWER = {
  e_canhoto: "sim",
  numero_documento_lido: null,
  data_recebimento_lida: null,
  tem_assinatura: "sim",
  nome_recebedor_lido: null,
  legivel: "sim",
  qualidade_foto: 0.9,
  confianca: 0.9,
  observacao: "ok",
};

const periods = new Map<string, string>();

let fleet: FleetDriverSeed;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function timeout() {
  // No status: a timeout or a dropped connection.
  return new FakeProviderError(undefined, "Request timed out.");
}

async function periodOf(businessId: string): Promise<string> {
  const known = periods.get(businessId);
  if (known) return known;

  const period = await prisma.aIUsagePeriod.create({
    data: {
      businessId,
      periodStart: quotaPeriodFor(new Date(), null).periodStart,
      reservedUnits: 100,
    },
  });

  periods.set(businessId, period.id);

  return period.id;
}

async function ledger(businessId: string) {
  const period = await prisma.aIUsagePeriod.findUniqueOrThrow({
    where: { id: await periodOf(businessId) },
  });

  return { reserved: period.reservedUnits, consumed: period.consumedUnits };
}

/** A fueling with its odometer analysis queued, as requestAnalysis leaves it. */
async function queueFuel(overrides: Record<string, unknown> = {}) {
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
      periodId: await periodOf(FLEET),
      requestedById: fleet.driverUserId,
      input: { odometerPhotoPath: fuel.odometer_photo, reportedMileage: 1000 },
      ...overrides,
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: ODOMETER_UNIT_KEY },
  });

  return { requestId: request.id, fuelId: fuel.id };
}

/** A queued receipt analysis with its one reserved unit. */
async function queueProof(
  businessId: string,
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "DELIVERY_PROOF",
      recordId: await seedProofCard(prisma, {
        businessId: businessId,
        photoPath: `${tag}.jpg`,
      }),
      businessId,
      periodId: await periodOf(businessId),
      requestedById: randomUUID(),
      input: {
        photoPath: `${tag}.jpg`,
        signaturePath: null,
        expectedDocument: null,
        expectedRecipient: "Destinatário",
        provenOn: "2026-09-24",
      },
      ...overrides,
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "proof" },
  });

  return request.id;
}

async function requestRow(requestId: string) {
  return prisma.aIAnalysisRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { units: { include: { attempts: true } } },
  });
}

/** Puts a re-queued request's due time in the past, as the clock would. */
async function makeDue(requestId: string) {
  await prisma.aIAnalysisRequest.update({
    where: { id: requestId },
    data: { availableAt: new Date(Date.now() - SECOND) },
  });
}

function emittedSteps(recordId: string) {
  return vi
    .mocked(sendAIVerificationEvent)
    .mock.calls.map(([, event]) => event as Record<string, unknown>)
    .filter((event) => event.recordId === recordId);
}

beforeAll(async () => {
  // The notification pipeline is not under test.
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "62777444000190",
  });
}, 60_000);

beforeEach(async () => {
  resetCircuit(pipeline);

  // Every case starts from an empty queue: a cycle drains whatever is due.
  await prisma.aIAnalysisRequest.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "COMPLETED", leaseExpiresAt: null },
  });

  vi.mocked(sendAIVerificationEvent).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("a claimed fuel analysis", () => {
  it("runs to the end: the reading on the record, the unit and the quota settled once", async () => {
    const provider = vi.fn(async () => READS_1000);

    pipeline.provider = fakeAnalyzer({ analyzeOdometerImage: provider });

    const { requestId, fuelId } = await queueFuel();
    const before = await ledger(FLEET);

    await pipeline.runCycle();

    const row = await requestRow(requestId);
    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    expect(provider).toHaveBeenCalledTimes(1);

    expect(row).toMatchObject({ status: "COMPLETED", attempts: 1, lastError: null });
    expect(row.completedAt).not.toBeNull();

    expect(row.units[0].status).toBe("CONSUMED");
    expect(row.units[0].attempts.map((attempt) => attempt.status)).toEqual([
      "SUCCEEDED",
    ]);

    expect(fuel).toMatchObject({
      odometer_ai_status: "verified",
      odometer_ai_reading: 1000,
      odometer_verified: true,
    });

    // Charged exactly once: the reservation became consumption.
    expect(await ledger(FLEET)).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed + 1,
    });

    expect(emittedSteps(fuelId).map((event) => event.step)).toEqual([
      "queued",
      "analyzing",
      "reading_odometer",
      "completed",
    ]);
  });
});

describe("a provider that times out", () => {
  it("puts the request back in the queue with the backoff, and the backoff is honoured", async () => {
    const provider = vi.fn(async () => {
      throw timeout();
    });

    pipeline.provider = fakeAnalyzer({ analyzeOdometerImage: provider });

    const { requestId, fuelId } = await queueFuel();
    const before = await ledger(FLEET);

    const firstAt = Date.now();
    await pipeline.runCycle();

    let row = await requestRow(requestId);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(row.lastError).toContain("timed out");

    // First backoff step: 30 s +/-20% jitter (plus however long the cycle took).
    expect(row.availableAt.getTime() - firstAt).toBeGreaterThanOrEqual(24 * SECOND);
    expect(row.availableAt.getTime() - firstAt).toBeLessThanOrEqual(41 * SECOND);

    // Nothing charged, nothing given back: the unit waits for the retry.
    expect(row.units[0].status).toBe("RESERVED");
    expect(row.units[0].attempts.map((attempt) => attempt.status)).toEqual(["FAILED"]);
    expect(await ledger(FLEET)).toEqual(before);

    // A sweep inside the backoff does not call the provider again.
    await pipeline.runCycle();
    expect(provider).toHaveBeenCalledTimes(1);

    // Once due, the second attempt; its failure waits the second step, 2 min.
    await makeDue(requestId);

    const secondAt = Date.now();
    await pipeline.runCycle();

    row = await requestRow(requestId);

    expect(provider).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({ status: "PENDING", attempts: 2 });
    expect(row.availableAt.getTime() - secondAt).toBeGreaterThanOrEqual(96 * SECOND);
    expect(row.availableAt.getTime() - secondAt).toBeLessThanOrEqual(144 * SECOND + 5 * SECOND);

    // The record keeps saying "analyzing" while a retry is ahead.
    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("analyzing");
  });

  it("ends FAILED once the last allowed attempt times out, and gives the reservation back", async () => {
    const provider = vi.fn(async () => {
      throw timeout();
    });

    pipeline.provider = fakeAnalyzer({ analyzeOdometerImage: provider });

    const { requestId, fuelId } = await queueFuel();
    const before = await ledger(FLEET);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await pipeline.runCycle();
      await makeDue(requestId);
    }

    // And a few sweeps more: nothing left to claim.
    await pipeline.runCycle();
    await pipeline.runCycle();

    const row = await requestRow(requestId);

    expect(provider).toHaveBeenCalledTimes(4);
    expect(row).toMatchObject({ status: "FAILED", attempts: 4 });
    expect(row.units[0].status).toBe("RELEASED");
    expect(row.units[0].attempts).toHaveLength(4);

    expect(await ledger(FLEET)).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });

    // The person who registered the fueling is told, instead of a spinner.
    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("error");
    expect(emittedSteps(fuelId).slice(-1)[0]).toMatchObject({
      step: "completed",
      overallStatus: "error",
    });
  });
});

describe("the poison guard", () => {
  it("still lets the last allowed attempt call the provider", async () => {
    const provider = vi.fn(async () => READS_1000);

    pipeline.provider = fakeAnalyzer({ analyzeOdometerImage: provider });

    // Interrupted during its third attempt: the claim makes this the fourth.
    const { requestId } = await queueFuel({
      status: "PROCESSING",
      attempts: 3,
      leaseExpiresAt: new Date(Date.now() - MINUTE),
    });

    await pipeline.runCycle();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(await requestRow(requestId)).toMatchObject({
      status: "COMPLETED",
      attempts: 4,
    });
  });

  it("ends a fuel analysis past its budget as FAILED, without the provider, once", async () => {
    const provider = vi.fn(async () => READS_1000);

    pipeline.provider = fakeAnalyzer({ analyzeOdometerImage: provider });

    // Its fourth attempt was interrupted too (a crash, a deploy): the claim
    // makes this the fifth.
    const { requestId, fuelId } = await queueFuel({
      status: "PROCESSING",
      attempts: 4,
      leaseExpiresAt: new Date(Date.now() - MINUTE),
    });

    const before = await ledger(FLEET);

    await pipeline.runCycle();

    // Settled for good: later sweeps do not pick it up again.
    await pipeline.runCycle();
    await pipeline.runCycle();

    const row = await requestRow(requestId);

    expect(provider).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(row.lastError).toContain("última tentativa");
    expect(row.units[0].status).toBe("RELEASED");

    expect(await ledger(FLEET)).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });

    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("error");
  });

  it("does not leave a checklist it ends saying 'analyzing' forever", async () => {
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
        // The photos the request reads are the record's (AI-4 fence).
        photos_by_field: {
          tires_condition: ["tires_condition.jpg"],
          bumpers_condition: ["bumpers_condition.jpg"],
        },
        // What the interrupted attempts left on it.
        ai_verification_status: "analyzing",
        businessId: FLEET,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
      },
    });

    const fields = ["tires_condition", "bumpers_condition"];

    const request = await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "CHECKLIST",
        recordId: checklist.id,
        businessId: FLEET,
        periodId: await periodOf(FLEET),
        requestedById: fleet.driverUserId,
        status: "PROCESSING",
        attempts: 4,
        leaseExpiresAt: new Date(Date.now() - MINUTE),
        input: {
          photosByField: Object.fromEntries(fields.map((f) => [f, [`${f}.jpg`]])),
          checklistData: Object.fromEntries(fields.map((f) => [f, "good"])),
        },
      },
    });

    await prisma.aIAnalysisUnit.createMany({
      data: fields.map((unitKey) => ({ requestId: request.id, unitKey })),
    });

    const provider = vi.fn();

    pipeline.provider = fakeAnalyzer({ analyzeChecklistImage: provider });

    await pipeline.runCycle();

    const row = await requestRow(request.id);

    expect(provider).not.toHaveBeenCalled();
    expect(row.status).toBe("FAILED");
    expect(row.units.every((unit) => unit.status === "RELEASED")).toBe(true);

    // Nothing was analysed: the record says so, and the screen is told.
    const settled = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(settled.ai_verification_status).toBe("error");
    expect(settled.ai_verified_at).not.toBeNull();
    expect(emittedSteps(checklist.id).slice(-1)[0]).toMatchObject({
      step: "completed",
      overallStatus: "error",
    });
  });

  it("ends a checklist with the fields analysed before it: their verdict, and the alert for a contradiction", async () => {
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
        // The photos the request reads are the record's (AI-4 fence).
        photos_by_field: {
          tires_condition: ["tires_condition.jpg"],
          bumpers_condition: ["bumpers_condition.jpg"],
        },
        ai_verification_status: "analyzing",
        businessId: FLEET,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
      },
    });

    const fields = ["tires_condition", "bumpers_condition"];

    const request = await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "CHECKLIST",
        recordId: checklist.id,
        businessId: FLEET,
        periodId: await periodOf(FLEET),
        requestedById: fleet.driverUserId,
        status: "PROCESSING",
        attempts: 4,
        leaseExpiresAt: new Date(Date.now() - MINUTE),
        input: {
          photosByField: Object.fromEntries(fields.map((f) => [f, [`${f}.jpg`]])),
          checklistData: Object.fromEntries(fields.map((f) => [f, "good"])),
        },
      },
    });

    // The interrupted attempts got as far as the tyres, which the photo
    // contradicts; the bumpers never had their turn.
    const contradiction = {
      status: "contradicts",
      confidence: 0.9,
      observation: "pneu careca",
      photosAnalyzed: 1,
    };

    await prisma.aIAnalysisUnit.createMany({
      data: [
        {
          requestId: request.id,
          unitKey: "tires_condition",
          status: "CONSUMED",
          result: contradiction,
          consumedAt: new Date(),
        },
        { requestId: request.id, unitKey: "bumpers_condition" },
      ],
    });

    const provider = vi.fn();

    pipeline.provider = fakeAnalyzer({ analyzeChecklistImage: provider });

    const before = await ledger(FLEET);

    await pipeline.runCycle();

    const row = await requestRow(request.id);

    expect(provider).not.toHaveBeenCalled();
    expect(row.status).toBe("PARTIAL");

    const byKey = Object.fromEntries(row.units.map((unit) => [unit.unitKey, unit.status]));

    expect(byKey).toEqual({ tires_condition: "CONSUMED", bumpers_condition: "RELEASED" });

    // Only the reservation nobody used goes back.
    expect(await ledger(FLEET)).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });

    // The paid field is what the record says, not "analyzing" nor "error".
    const settled = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(settled.ai_verification_status).toBe("issues_found");
    expect(settled.ai_verification_details).toMatchObject({
      tires_condition: { status: "contradicts" },
    });

    // The admins hear about the contradiction, once.
    expect(
      await prisma.domainOutboxEvent.count({
        where: { eventKey: `ai-verification.issue:${request.id}` },
      }),
    ).toBe(1);

    expect(emittedSteps(checklist.id).slice(-1)[0]).toMatchObject({
      step: "completed",
      overallStatus: "issues_found",
    });
  });
});

describe("a stale worker whose provider call succeeds after another replica took over", () => {
  it("neither writes its verdict nor settles the request, and nothing is charged twice", async () => {
    const entered = deferred();
    const latch = deferred();

    // The stale worker's call: slow, and it reads a different number than the
    // new owner will have written.
    pipeline.provider = fakeAnalyzer({
      analyzeOdometerImage: async () => {
        entered.resolve();
        await latch.promise;

        return {
          parsed: {
            valor_lido: 1003,
            confianca: 0.9,
            legivel: true,
            sinais_fraude: false,
            motivos_fraude: [],
            observacao: "tarde",
          },
          usage: USAGE,
        };
      },
    });

    const { requestId, fuelId } = await queueFuel();
    const before = await ledger(FLEET);

    const staleCycle = pipeline.runCycle();

    await entered.promise;

    // Meanwhile the lease ran out, another replica claimed the request (the
    // claim bumps attempts), read the photo and wrote its verdict — and is
    // still about to settle it.
    await prisma.aIAnalysisRequest.update({
      where: { id: requestId },
      data: {
        attempts: { increment: 1 },
        leaseExpiresAt: new Date(Date.now() + 5 * MINUTE),
      },
    });

    await prisma.fuel.update({
      where: { id: fuelId },
      data: { odometer_ai_status: "verified", odometer_ai_reading: 1000 },
    });

    latch.resolve();
    await staleCycle;

    const row = await requestRow(requestId);
    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    // Still the new owner's to settle.
    expect(row).toMatchObject({ status: "PROCESSING", attempts: 2 });

    // The new owner's verdict stands.
    expect(fuel.odometer_ai_reading).toBe(1000);

    // The photo was paid for once and its result kept, charged once.
    expect(row.units[0].status).toBe("CONSUMED");
    expect(await ledger(FLEET)).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed + 1,
    });

    // The stale worker told the user nothing was completed.
    expect(
      emittedSteps(fuelId).some((event) => event.step === "completed"),
    ).toBe(false);
  });
});

describe("the fair claim, with two companies that both have a backlog", () => {
  it("gives each company's oldest requests the first slots, not one company's four", async () => {
    const started: string[] = [];
    const allFourIn = deferred();
    const release = deferred();

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async (photoPath: string) => {
        started.push(photoPath.replace(/\.jpg$/, ""));

        // Hold the first claim's four calls until all four are in, so no slot
        // frees (and no second claim runs) before they are counted.
        if (started.length === 4) allFourIn.resolve();
        if (started.length <= 4) await release.promise;

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    const base = Date.now() - 10 * MINUTE;

    // Every one of A's requests is older than every one of B's.
    for (let n = 0; n < 6; n += 1) {
      await queueProof(CARRIER_A, `A-${n}`, { created_at: new Date(base + n * SECOND) });
    }

    for (let n = 0; n < 6; n += 1) {
      await queueProof(CARRIER_B, `B-${n}`, {
        created_at: new Date(base + MINUTE + n * SECOND),
      });
    }

    const cycle = pipeline.runCycle();

    await allFourIn.promise;

    const firstClaim = [...started].sort();

    release.resolve();
    await cycle;

    // Two of each, the oldest of each: by age alone it was A-0..A-3.
    expect(firstClaim).toEqual(["A-0", "A-1", "B-0", "B-1"]);
    expect(started).toHaveLength(12);
  });
});
