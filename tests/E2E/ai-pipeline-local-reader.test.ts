import "@/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPrismaClient } from "@/shared/database/database-client";

// The reader is "configured" so AIAnalysisService queues; the pipeline's
// wake is stubbed below, and every read goes to a FakeImageReader.
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

vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

import {
  AIAnalysisPipelineService,
  AI_BUSY_RETRY_MIN_MS,
  AI_BUSY_RETRY_SPREAD_MS,
} from "@/shared/ai/ai-analysis-pipeline-service";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { AIAnalysisProvider } from "@/shared/ai/ai-provider";
import { ODOMETER_UNIT_KEY } from "@/shared/ai/ai-rules";
import { LocalOcrReader } from "@/shared/ai/local/local-ocr-reader";
import { ProviderCircuit } from "@/shared/ai/provider-circuit";
import { UNSUPPORTED_BY_READER_MARKER } from "@/shared/ai/provider-failure";
import {
  FakeImageReader,
  fakeImageLoader,
  type FakeImageReaderOptions,
} from "@/shared/ai/testing/fake-image-reader";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { deviceAgreementTotals } from "@/shared/ai-precheck/device-agreement-metrics";
import { aiCredentialFailuresSql } from "@/shared/health/operational-snapshot";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { sendAIVerificationEvent } from "@/websocket";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { seedProofCard } from "./support/proof-card-seed";

/**
 * The pipeline with the local OCR reader's behaviour (ADR 0010, rewritten
 * 05/10/2026), through FakeImageReader: coverage per kind, back-pressure
 * (busy), a refused token, units reserved under a reader that covered more,
 * and what OCR does not judge (signature, fraud). Real Postgres: the queue,
 * the ledger and the records are the product's own.
 */
const prisma = createPrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  circuit: ProviderCircuit;
  runCycle: () => Promise<void>;
};

const BUSINESS = "018fdcc0-0000-7000-8000-0000000000a1";

const ODOMETER = {
  valor_lido: 1000,
  confianca: 0.97,
  legivel: true,
  sinais_fraude: false,
  fraude_avaliada: false,
  motivos_fraude: [],
  observacao: "Leitura automática (OCR).",
};

const RECEIPT = {
  e_canhoto: "sim",
  numero_documento_lido: "000045118",
  data_recebimento_lida: "27/09/2026",
  tem_assinatura: "nao_sei",
  assinatura_avaliada: false,
  nome_recebedor_lido: null,
  legivel: "sim",
  qualidade_foto: 0.98,
  confianca: 0.98,
  observacao: "Leitura automática (OCR).",
};

let fleet: FleetDriverSeed;
let periodId = "";

/** The OCR reader's coverage: the receipt and the odometer. */
function ocrReader(options: FakeImageReaderOptions = {}) {
  const reader = new FakeImageReader({
    supports: ["proof", "odometer"],
    maxConcurrency: 1,
    answers: { odometer: ODOMETER, proof: RECEIPT },
    ...options,
  });

  pipeline.provider = new AIAnalysisProvider(reader, fakeImageLoader);

  return reader;
}

async function ledger() {
  const period = await prisma.aIUsagePeriod.findUniqueOrThrow({
    where: { id: periodId },
  });

  return { reserved: period.reservedUnits, consumed: period.consumedUnits };
}

/** The last "completed" realtime event sent for a record. */
function completedEvent(recordId: string): Record<string, unknown> | undefined {
  const events = vi
    .mocked(sendAIVerificationEvent)
    .mock.calls.map(([, event]) => event as Record<string, unknown>)
    .filter(
      (event) => event.recordId === recordId && event.step === "completed",
    );

  return events[events.length - 1];
}

async function makeDue(requestId: string) {
  await prisma.aIAnalysisRequest.update({
    where: { id: requestId },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
}

async function reserve(count: number) {
  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { increment: count } },
  });
}

async function queueFuel() {
  const photo = `odometerPhotos/${BUSINESS}/${randomUUID()}.jpg`;

  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 1000,
      liters_amount: 50,
      price_per_liter: 6,
      total_amount: 300,
      odometer_photo: photo,
      odometer_ai_status: "pending",
      businessId: BUSINESS,
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
      businessId: BUSINESS,
      periodId,
      requestedById: fleet.driverUserId,
      input: { odometerPhotoPath: photo, reportedMileage: 1000 },
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: ODOMETER_UNIT_KEY },
  });
  await reserve(1);

  return { requestId: request.id, fuelId: fuel.id, photo };
}

/** A checklist whose units were reserved as a reader that read EVERY photo left them. */
async function queueChecklist(fields: string[]) {
  const photosByField = Object.fromEntries(
    fields.map((field) => [
      field,
      [`checklistPhotos/${BUSINESS}/${randomUUID()}-${field}.jpg`],
    ]),
  );

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
      photos_by_field: photosByField,
      ai_verification_status: "pending",
      businessId: BUSINESS,
      branchId: fleet.branchId,
      vehicleId: fleet.vehicleId,
      driverId: fleet.driverId,
    },
  });

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: BUSINESS,
      periodId,
      requestedById: fleet.driverUserId,
      input: {
        photosByField,
        checklistData: Object.fromEntries(
          fields.map((field) => [
            field,
            field === "current_mileage"
              ? 1000
              : field === "fuel_level_adequate"
                ? true
                : "good",
          ]),
        ),
      },
    },
  });

  // One by one: the pipeline walks them in creation order.
  for (const field of fields) {
    await prisma.aIAnalysisUnit.create({
      data: { requestId: request.id, unitKey: field },
    });
  }

  await reserve(fields.length);

  return { requestId: request.id, checklistId: checklist.id };
}

async function queueProof(signature: string | null) {
  const photo = `deliveryPhotos/${BUSINESS}/${randomUUID()}.jpg`;

  const deliveryId = await seedProofCard(prisma, {
    businessId: BUSINESS,
    photoPath: photo,
    invoiceNumber: "45118",
    reportedById: fleet.driverUserId,
    signature,
  });

  const input = buildProofAnalysisInput({
    photoPath: photo,
    signaturePath: signature,
    delivery: { invoice_number: "45118", recipient_name: "Mercado Central" },
    provenAt: new Date("2026-09-27T15:00:00.000Z"),
    timeZone: "America/Sao_Paulo",
  });

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "DELIVERY_PROOF",
      recordId: deliveryId,
      businessId: BUSINESS,
      periodId,
      requestedById: fleet.driverUserId,
      input: input as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "proof" },
  });
  await reserve(1);

  return { requestId: request.id, deliveryId };
}

beforeAll(async () => {
  vi.spyOn(AIAnalysisPipelineService.prototype, "wake").mockImplementation(
    () => undefined,
  );
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "62777999000190",
  });

  await prisma.business.update({
    where: { id: BUSINESS },
    data: { ai_analysis_limit: 1000 },
  });

  periodId = (
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: BUSINESS,
        periodStart: quotaPeriodFor(new Date(), null).periodStart,
      },
    })
  ).id;
}, 60_000);

beforeEach(async () => {
  pipeline.circuit = new ProviderCircuit();

  // Each case sees only its own queue.
  await prisma.aIAnalysisRequest.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "COMPLETED", leaseExpiresAt: null },
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("a busy reader (its queue full, HTTP 503): back-pressure, not failure", () => {
  // Red before: a 503 was a transient failure — each one spent an attempt
  // (four and the request FAILED with the unit given back) and five in a
  // row opened the circuit as if the service were down.
  it("puts the request back in 5–15 s, the attempt given back, the unit still reserved", async () => {
    const reader = ocrReader({ failures: ["busy"] });
    const { requestId, fuelId } = await queueFuel();
    const before = await ledger();
    const startedAt = Date.now();

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(reader.calls).toHaveLength(1);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.units[0].status).toBe("RESERVED");
    // Red before: every busy answer wrote a FAILED attempt row and the
    // unit's lastError, so the audit trail filled with failures that never were.
    expect(row.units[0].lastError).toBeNull();
    expect(
      await prisma.aIProviderAttempt.count({
        where: { unitId: row.units[0].id },
      }),
    ).toBe(0);
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + AI_BUSY_RETRY_MIN_MS - 1_000,
    );
    expect(row.availableAt.getTime()).toBeLessThanOrEqual(
      Date.now() + AI_BUSY_RETRY_MIN_MS + AI_BUSY_RETRY_SPREAD_MS + 1_000,
    );
    expect(await ledger()).toEqual(before);
    expect(pipeline.circuit.snapshot().state).toBe("closed");

    // Not due yet: nobody claims it.
    await pipeline.runCycle();
    expect(reader.calls).toHaveLength(1);

    await makeDue(requestId);
    await pipeline.runCycle();

    const done = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(done.status).toBe("COMPLETED");
    expect(done.attempts).toBe(1);
    expect(done.units[0].status).toBe("CONSUMED");
    expect(
      await prisma.aIProviderAttempt.findMany({
        where: { unitId: done.units[0].id },
        select: { attemptNo: true, status: true },
      }),
    ).toEqual([{ attemptNo: 1, status: "SUCCEEDED" }]);
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed + 1,
    });

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });
    expect(fuel.odometer_ai_status).toBe("verified");
  });

  it("never opens the circuit however long it lasts", async () => {
    ocrReader({ failures: Array(12).fill("busy") });
    const queued = [await queueFuel(), await queueFuel(), await queueFuel()];

    for (let round = 0; round < 4; round++) {
      for (const { requestId } of queued) await makeDue(requestId);
      await pipeline.runCycle();
    }

    expect(pipeline.circuit.snapshot().state).toBe("closed");

    const rows = await prisma.aIAnalysisRequest.findMany({
      where: { id: { in: queued.map((entry) => entry.requestId) } },
    });

    expect(
      rows.every((row) => row.status === "PENDING" && row.attempts === 0),
    ).toBe(true);
  });

  it("in a checklist keeps the fields already read, and waits with the rest", async () => {
    // A reader that reads every kind, so two fields are units.
    const reader = ocrReader({
      supports: undefined,
      failures: [null, "busy"],
      answers: {
        odometer: ODOMETER,
        condition: {
          condicao_observada: "good",
          confianca: 0.9,
          observacao: "",
        },
      },
    });

    const { requestId } = await queueChecklist([
      "current_mileage",
      "tires_condition",
    ]);
    const before = await ledger();

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: { orderBy: { created_at: "asc" } } },
    });

    expect(reader.calls.map((call) => call.kind)).toEqual([
      "odometer",
      "condition",
    ]);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.units.map((unit) => [unit.unitKey, unit.status])).toEqual([
      ["current_mileage", "CONSUMED"],
      ["tires_condition", "RESERVED"],
    ]);
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed + 1,
    });
  });
});

describe("a refused token (HTTP 401)", () => {
  it("fails the request that met it, gives its unit back and pauses the queue", async () => {
    ocrReader({ failures: ["unauthorized"] });

    const first = await queueFuel();
    const before = await ledger();

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: first.requestId },
      include: { units: true },
    });

    expect(row.status).toBe("FAILED");
    expect(row.units[0].status).toBe("RELEASED");
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });
    expect(pipeline.circuit.snapshot()).toMatchObject({
      state: "open",
      reason: "unauthorized",
    });

    // The backlog waits for the probe instead of failing with it.
    const second = await queueFuel();
    await pipeline.runCycle();

    const waiting = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: second.requestId },
    });

    expect(waiting).toMatchObject({ status: "PENDING", attempts: 0 });
  });
});

describe("a refused AI_LOCAL_TOKEN, through the real LocalOcrReader", () => {
  // Red before: the reader's message ("Serviço de IA local respondeu 401
  // (unauthorized)") matched none of the ops alert's credential patterns,
  // which still spoke the Anthropic SDK's wording — a token mismatch between
  // the api and trajetto-ai failed every request in silence.
  it("is counted by the ops credential alert", async () => {
    const service = http.createServer((request, response) => {
      // Like trajetto-ai: the body is read before the refusal is sent.
      request.resume();
      request.on("end", () => {
        response.writeHead(401, {
          "Content-Type": "application/json",
          Connection: "close",
        });
        response.end(JSON.stringify({ error: "unauthorized" }));
      });
    });

    await new Promise<void>((resolve) =>
      service.listen(0, "127.0.0.1", resolve),
    );
    const { port } = service.address() as AddressInfo;

    try {
      const reader = new LocalOcrReader({
        url: `http://127.0.0.1:${port}`,
        token: "w".repeat(40),
        timeoutMs: 5_000,
        maxConcurrency: 1,
      });

      pipeline.provider = new AIAnalysisProvider(reader, fakeImageLoader);

      const since = new Date(Date.now() - 1_000);
      const credentialFailures = async () =>
        (
          await prisma.$queryRaw<Array<{ n: number }>>(
            aiCredentialFailuresSql(since),
          )
        )[0].n;

      const before = await credentialFailures();
      const { requestId } = await queueFuel();

      await pipeline.runCycle();

      const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      expect(row.status).toBe("FAILED");
      expect(row.lastError).toMatch(/^401 unauthorized: /);
      expect(row.lastError).not.toContain("w".repeat(40));
      expect(await credentialFailures()).toBe(before + 1);
    } finally {
      await new Promise((resolve) => service.close(resolve));
    }
  });
});

describe("units reserved under a reader that covered more (ADR 0010 §5)", () => {
  // Red before: the OCR reader was asked about a tyre and a fuel gauge, and
  // the units were spent (or failed) on readings it cannot give.
  it("gives back the tyre and the fuel gauge, reads only the odometer", async () => {
    const reader = ocrReader();
    const { requestId, checklistId } = await queueChecklist([
      "current_mileage",
      "tires_condition",
      "fuel_level_adequate",
    ]);
    const before = await ledger();

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: { orderBy: { created_at: "asc" } } },
    });

    expect(reader.calls.map((call) => call.kind)).toEqual(["odometer"]);
    expect(row.status).toBe("COMPLETED");
    expect(
      row.units.map((unit) => [unit.unitKey, unit.status, unit.lastError]),
    ).toEqual([
      ["current_mileage", "CONSUMED", null],
      ["tires_condition", "RELEASED", UNSUPPORTED_BY_READER_MARKER],
      ["fuel_level_adequate", "RELEASED", UNSUPPORTED_BY_READER_MARKER],
    ]);
    expect(await ledger()).toEqual({
      reserved: before.reserved - 3,
      consumed: before.consumed + 1,
    });

    const checklist = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklistId },
    });
    expect(checklist.ai_verification_details).toMatchObject({
      current_mileage: { status: "confirmed", fraudAssessed: false },
    });

    // Red before: "Todas as condições verificadas com sucesso" for a km
    // read without any fraud check.
    expect(completedEvent(checklistId)).toMatchObject({
      overallStatus: "verified",
      currentResult: {
        fraudAssessed: false,
        details: expect.stringMatching(
          /^Km lida confere com a informada\. A leitura automática não identifica foto de tela/,
        ),
      },
    });
  });

  it("with nothing covered, settles without a call and marks the checklist not analysed — never 'error'", async () => {
    const reader = ocrReader();
    const { requestId, checklistId } = await queueChecklist([
      "tires_condition",
    ]);
    const before = await ledger();

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(reader.calls).toHaveLength(0);
    expect(row.status).toBe("COMPLETED");
    expect(row.lastError).toBe(UNSUPPORTED_BY_READER_MARKER);
    expect(row.units[0].status).toBe("RELEASED");
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });

    const checklist = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklistId },
    });
    expect(checklist.ai_verification_status).toBe("skipped");
  });
});

describe("what OCR does not judge never reaches the record as judged", () => {
  it("an odometer that matches is 'km confere' without the 'verified' seal", async () => {
    ocrReader();
    const { fuelId } = await queueFuel();

    await pipeline.runCycle();

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    expect(fuel.odometer_ai_status).toBe("verified");
    // Red before: the seal followed the status.
    expect(fuel.odometer_verified).toBe(false);
    expect(fuel.odometer_ai_details).toMatchObject({
      fraudAssessed: false,
      details: expect.stringMatching(/^Km lida confere com a informada/),
    });

    // Red before: the live event said only "verified", so a screen drawing
    // the badge from it had nothing to tell "km confere" from "Verificado".
    expect(completedEvent(fuelId)).toMatchObject({
      overallStatus: "verified",
      currentResult: { status: "verified", fraudAssessed: false },
    });
  });

  it("a clean receipt with the on-screen signature goes to a person, never 'looks_good'", async () => {
    ocrReader({ answers: { proof: { ...RECEIPT } } });

    const { deliveryId } = await queueProof(
      `deliverySignatures/${BUSINESS}/assinatura.png`,
    );

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    // Red before: the on-screen signature settled it and the card read
    // "looks_good" on the machine's word alone.
    expect(card.ai_suggestion).toMatchObject({
      reading: {
        hasSignature: "unknown",
        documentMatches: "yes",
        extracted: { digitalSignature: true, signatureAssessed: false },
      },
      assessment: { suggestion: "needs_review", failed: [] },
    });

    // A doubt is the office's: the driver is not told.
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(0);
  });

  it("a receipt of another invoice is 'looks_wrong' and the driver is told", async () => {
    ocrReader({
      answers: { proof: { ...RECEIPT, numero_documento_lido: "000099999" } },
    });

    const { deliveryId } = await queueProof(null);

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      assessment: { suggestion: "looks_wrong", failed: ["documentMatches"] },
    });
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(1);
  });
});

describe("reads in flight per replica", () => {
  it("never more than the reader's maxConcurrency (the service reads one at a time)", async () => {
    let active = 0;
    let peak = 0;

    ocrReader({
      maxConcurrency: 1,
      onRead: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
      },
    });

    for (let i = 0; i < 4; i++) await queueFuel();

    await pipeline.runCycle();

    expect(peak).toBe(1);
  });
});

describe("one photo = one unit, once (ADR 0010 §5)", () => {
  it("N submissions of the same fuelling and M passes of the pipeline consume exactly one unit", async () => {
    const reader = ocrReader();

    const photo = `odometerPhotos/${BUSINESS}/${randomUUID()}.jpg`;
    const fuel = await prisma.fuel.create({
      data: {
        current_mileage: 1000,
        liters_amount: 10,
        price_per_liter: 6,
        total_amount: 60,
        odometer_photo: photo,
        businessId: BUSINESS,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
        fuelTypeId: fleet.fuelTypeId,
      },
    });

    const submit = () =>
      AIAnalysisService.getInstance().requestAnalysis({
        type: "FUEL_ODOMETER",
        recordId: fuel.id,
        businessId: BUSINESS,
        requestedById: fleet.driverUserId,
        input: { odometerPhotoPath: photo, reportedMileage: 1000 },
      });

    const before = await ledger();

    // The outbox replays the same submission; the screen asks again.
    const outcomes = await Promise.all([
      submit(),
      submit(),
      submit(),
      submit(),
      submit(),
    ]);
    expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(1);

    for (let pass = 0; pass < 3; pass++) {
      const requests = await prisma.aIAnalysisRequest.findMany({
        where: { recordId: fuel.id },
      });
      for (const request of requests) await makeDue(request.id);
      await pipeline.runCycle();
      expect(await submit()).toBe("already_completed");
    }

    expect(reader.calls).toHaveLength(1);
    expect(
      await prisma.aIAnalysisRequest.count({ where: { recordId: fuel.id } }),
    ).toBe(1);
    expect(await ledger()).toEqual({
      reserved: before.reserved,
      consumed: before.consumed + 1,
    });
  });

  it("a checklist of eight photos with one odometer reserves and consumes one", async () => {
    const reader = ocrReader();
    const fields = [
      "current_mileage",
      "tires_condition",
      "fuel_level_adequate",
      "windshield_condition",
      "headlights_working",
      "brakes_working",
      "spare_tire_condition",
      "fire_extinguisher_valid",
    ];
    const photosByField = Object.fromEntries(
      fields.map((field) => [
        field,
        [`checklistPhotos/${BUSINESS}/${randomUUID()}.jpg`],
      ]),
    );

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
        photos_by_field: photosByField,
        businessId: BUSINESS,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
      },
    });

    const before = await ledger();

    const outcome = await AIAnalysisService.getInstance().requestAnalysis({
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: BUSINESS,
      requestedById: fleet.driverUserId,
      input: {
        photosByField,
        checklistData: checklist as unknown as Record<string, unknown>,
      },
    });

    expect(outcome).toBe("queued");
    expect(await ledger()).toEqual({
      reserved: before.reserved + 1,
      consumed: before.consumed,
    });

    await pipeline.runCycle();

    expect(reader.calls.map((call) => call.kind)).toEqual(["odometer"]);
    expect(await ledger()).toEqual({
      reserved: before.reserved,
      consumed: before.consumed + 1,
    });
  });
});

/**
 * The phone's offline pre-check against the server's reading of the same
 * photo (ADR 0010 §4, design §P5.2): the verdict goes into its own column
 * when the reading is written, never into the device's JSON, and is counted
 * in ai_device_agreement_total.
 */
describe("the device pre-check's agreement with the server's reading", () => {
  function precheck(kind: "proof" | "odometer", found: boolean) {
    return {
      engine: "mlkit-text-v2-latin",
      engine_version: "16.0.1",
      rules_version: 1,
      ran_at: new Date().toISOString(),
      duration_ms: 320,
      kind,
      invoice_number_found: kind === "proof" ? found : null,
      date_out_of_window: kind === "proof" ? false : null,
      typed_mileage_found: kind === "odometer" ? found : null,
      outcome: "ok",
      driver_overrode: false,
    };
  }

  it("writes AGREE on the receipt card when both found the invoice, and counts it", async () => {
    ocrReader();
    const { deliveryId } = await queueProof(null);
    const sent = precheck("proof", true);

    await prisma.deliveryProofAudit.update({
      where: { deliveryId },
      data: { device_precheck: sent },
    });

    const before = deviceAgreementTotals().proof.AGREE;

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.device_agreement).toBe("AGREE");
    // The device's declaration is kept as it was sent.
    expect(card.device_precheck).toEqual(sent);
    expect(deviceAgreementTotals().proof.AGREE).toBe(before + 1);
  });

  it("writes DISAGREE when the phone missed an invoice the server read", async () => {
    ocrReader();
    const { deliveryId } = await queueProof(null);

    await prisma.deliveryProofAudit.update({
      where: { deliveryId },
      data: { device_precheck: precheck("proof", false) },
    });

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.device_agreement).toBe("DISAGREE");
  });

  it("leaves the column empty when the phone sent no pre-check", async () => {
    ocrReader();
    const { deliveryId } = await queueProof(null);

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).not.toBeNull();
    expect(card.device_agreement).toBeNull();
  });

  it("writes the fuelling's odometer agreement", async () => {
    ocrReader();
    const { fuelId } = await queueFuel();

    await prisma.fuel.update({
      where: { id: fuelId },
      data: { odometer_device_precheck: precheck("odometer", true) },
    });

    const before = deviceAgreementTotals().fuel_odometer.AGREE;

    await pipeline.runCycle();

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    expect(fuel.odometer_ai_status).toBe("verified");
    expect(fuel.odometer_device_agreement).toBe("AGREE");
    expect(deviceAgreementTotals().fuel_odometer.AGREE).toBe(before + 1);
  });

  it("is NOT_APPLICABLE when the server could not read the odometer", async () => {
    ocrReader({
      answers: { odometer: { ...ODOMETER, legivel: false, valor_lido: null } },
    });
    const { fuelId } = await queueFuel();

    await prisma.fuel.update({
      where: { id: fuelId },
      data: { odometer_device_precheck: precheck("odometer", true) },
    });

    await pipeline.runCycle();

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    expect(fuel.odometer_ai_status).toBe("unreadable");
    expect(fuel.odometer_device_agreement).toBe("NOT_APPLICABLE");
  });

  it("writes the checklist's mileage agreement from the current_mileage reading", async () => {
    ocrReader();
    const { checklistId } = await queueChecklist(["current_mileage"]);

    await prisma.vehicleChecklist.update({
      where: { id: checklistId },
      data: { mileage_device_precheck: precheck("odometer", false) },
    });

    await pipeline.runCycle();

    const checklist = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklistId },
    });

    // The phone did not find the typed km; the server read it and it matches.
    expect(checklist.mileage_device_agreement).toBe("DISAGREE");
  });
});
