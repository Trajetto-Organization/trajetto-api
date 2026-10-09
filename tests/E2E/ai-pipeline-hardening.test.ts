import "@/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { container } from "tsyringe";

import database from "@/../infra/database";
import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import { ListProofAuditsUseCase } from "@/modules/delivery/usecases/list-proof-audits/list-proof-audits-usecase";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UpdateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-usecase";
import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { UploadService } from "@/shared/services/upload-service";
import { refreshChecklistVerdict } from "@/shared/ai/ai-record-store";
import { ODOMETER_UNIT_KEY } from "@/shared/ai/ai-rules";
import { ProviderCircuit } from "@/shared/ai/provider-circuit";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { sendAIVerificationEvent } from "@/websocket";

import { FakeProviderError, fakeVision, resetCircuit } from "./support/fake-vision";
import { seedFleetDriver, type FleetDriverSeed } from "./support/fleet-driver-seed";
import { seedProofCard } from "./support/proof-card-seed";

/**
 * The AI pipeline from the provider's TEXT to the record, with the real
 * analyzer and the real answer schema behind a fake model (ADR 0010): what
 * the wave-3 fixes are about, each red on the code before them.
 *
 * - AI-3: one confidence scale, stored under the key the screens read.
 * - AI-14: an invalid answer is retried once, not four paid times, and a
 *   missing key is never a verdict.
 * - AI-4: a late answer about a photo that was replaced writes nothing.
 * - AI-5: a receipt reading paid for but not attached is attached on retry.
 * - AI-7: the receipt's events say "proof".
 * - AI-8: the spend limit pauses the queue instead of failing it.
 * - 6.9: the prompts are blind; the driver hears about a receipt that
 *   looks wrong.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = new PrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  circuit: ProviderCircuit;
  runCycle: () => Promise<void>;
};

const FLEET = "018fdca0-0000-7000-8000-00000000000f";

const SECOND = 1_000;

let fleet: FleetDriverSeed;
let periodId = "";

function odometerText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    valor_lido: 1000,
    confianca: 0.9,
    legivel: true,
    sinais_fraude: false,
    motivos_fraude: [],
    observacao: "Odômetro digital nítido.",
    ...overrides,
  });
}

function proofText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    e_canhoto: "sim",
    numero_documento_lido: "0045118",
    data_recebimento_lida: "27/09/2026",
    tem_assinatura: "sim",
    nome_recebedor_lido: "Maria Souza",
    legivel: "sim",
    qualidade_foto: 0.9,
    confianca: 0.9,
    observacao: "Canhoto legível e assinado.",
    ...overrides,
  });
}

async function ledger() {
  const period = await prisma.aIUsagePeriod.findUniqueOrThrow({
    where: { id: periodId },
  });

  return { reserved: period.reservedUnits, consumed: period.consumedUnits };
}

async function makeDue(requestId: string) {
  await prisma.aIAnalysisRequest.update({
    where: { id: requestId },
    data: { availableAt: new Date(Date.now() - SECOND) },
  });
}

function emitted(recordId: string) {
  return vi
    .mocked(sendAIVerificationEvent)
    .mock.calls.map(([, event]) => event as Record<string, unknown>)
    .filter((event) => event.recordId === recordId);
}

/**
 * What the audit queue says about a card's automatic reading, through the
 * real use case and repository the "Auditoria de comprovantes" tabs call.
 */
async function aiStateOnTheQueue(
  deliveryId: string,
  status: "PENDING" | "APPROVED" | "REJECTED",
): Promise<string | undefined> {
  const manager = await prisma.user.findFirstOrThrow({
    where: { businessId: FLEET, role: "BUSINESS_ADMIN" },
  });

  const listed = await new ListProofAuditsUseCase(
    new UserRepository(prisma as never),
    new ProofAuditRepository(prisma as never),
    new UploadService(),
  ).execute({ userId: manager.id, status, page: 1, pageSize: 100 });

  return listed.data.find((card) => card.deliveryId === deliveryId)?.aiState;
}

/** A fuelling with its odometer reading queued, as requestAnalysis leaves it. */
async function queueFuel() {
  const photo = `odometerPhotos/${FLEET}/${randomUUID()}.jpg`;

  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 1000,
      liters_amount: 50,
      price_per_liter: 6,
      total_amount: 300,
      odometer_photo: photo,
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
      input: { odometerPhotoPath: photo, reportedMileage: 1000 },
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: ODOMETER_UNIT_KEY },
  });

  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { increment: 1 } },
  });

  return { requestId: request.id, fuelId: fuel.id, photo };
}

/**
 * A proven delivery with its card, and the reading of its receipt queued with
 * the input the product builds. `legacyInput` is the shape queued before
 * decision 6.9: the delivery's code as the expected document, no version.
 */
async function queueProof(
  options: { signature?: string | null; invoiceNumber?: string | null; legacyInput?: boolean } = {},
) {
  const photo = `deliveryPhotos/${FLEET}/${randomUUID()}.jpg`;
  const invoiceNumber =
    options.invoiceNumber === undefined ? "45118" : options.invoiceNumber;

  const deliveryId = await seedProofCard(prisma, {
    businessId: FLEET,
    photoPath: photo,
    invoiceNumber,
    reportedById: fleet.driverUserId,
    signature: options.signature ?? null,
  });

  const input = options.legacyInput
    ? {
        photoPath: photo,
        signaturePath: options.signature ?? null,
        expectedDocument: invoiceNumber ?? "ENT-000123",
        expectedRecipient: "Mercado Central",
        provenOn: "2026-09-27",
      }
    : buildProofAnalysisInput({
        photoPath: photo,
        signaturePath: options.signature ?? null,
        delivery: { invoice_number: invoiceNumber, recipient_name: "Mercado Central" },
        provenAt: new Date("2026-09-27T15:00:00.000Z"),
        timeZone: "America/Sao_Paulo",
      });

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "DELIVERY_PROOF",
      recordId: deliveryId,
      businessId: FLEET,
      periodId,
      requestedById: fleet.driverUserId,
      input: input as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "proof" },
  });

  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { increment: 1 } },
  });

  return { requestId: request.id, deliveryId, photo };
}

beforeAll(async () => {
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "62777555000190",
  });

  periodId = (
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: FLEET,
        periodStart: quotaPeriodFor(new Date(), null).periodStart,
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

  vi.mocked(sendAIVerificationEvent).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("an odometer read blind (ADR 0010, AI-3)", () => {
  it("never shows the model the informed mileage, and stores the confidence the screen reads", async () => {
    const prompts: string[] = [];

    pipeline.provider = fakeVision(({ prompt }) => {
      prompts.push(prompt);

      // The model answers on the old 0–100 scale.
      return odometerText({ confianca: 85 });
    });

    const { fuelId } = await queueFuel();

    await pipeline.runCycle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("1000");

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    expect(fuel.odometer_ai_status).toBe("verified");

    // Red before: the raw answer was stored, key `confianca`, value 85 —
    // "8500%" live and no badge after a refresh.
    expect(fuel.odometer_ai_details).toMatchObject({
      confidence: 0.85,
      readMileage: 1000,
      reportedMileage: 1000,
    });
    expect(fuel.odometer_ai_details).not.toHaveProperty("confianca");

    expect(emitted(fuelId).slice(-1)[0]).toMatchObject({
      step: "completed",
      recordType: "fuel",
      currentResult: { confidence: 0.85 },
    });
  });
});

describe("an answer that is not what was asked (AI-14)", () => {
  it("is tried once more, then settled as a failure — not four paid calls", async () => {
    let calls = 0;

    pipeline.provider = fakeVision(() => {
      calls += 1;
      return "Desculpe, não consegui analisar a imagem.";
    });

    const { requestId, fuelId } = await queueFuel();

    await pipeline.runCycle();

    const first = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    expect(first.status).toBe("PENDING");
    expect(first.lastError).toContain("AI_INVALID_RESPONSE");

    await makeDue(requestId);
    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: { include: { attempts: true } } },
    });

    expect(calls).toBe(2);
    expect(row.status).toBe("FAILED");
    expect(row.units[0].status).toBe("RELEASED");

    // Paid calls keep their tokens on the trail.
    expect(row.units[0].attempts.every((attempt) => attempt.inputTokens === 1)).toBe(
      true,
    );

    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("error");
  });

  it("is never a verdict when a key the verdict needs is missing", async () => {
    pipeline.provider = fakeVision(() =>
      JSON.stringify({ valor_lido: 1000, confianca: 0.9, observacao: "ok" }),
    );

    const { fuelId } = await queueFuel();

    await pipeline.runCycle();

    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("analyzing");
  });
});

describe("a reading of a photo that was replaced (AI-4)", () => {
  it("is not even asked for when the photo changed before the claim", async () => {
    let calls = 0;

    pipeline.provider = fakeVision(() => {
      calls += 1;
      return odometerText();
    });

    const { requestId, fuelId } = await queueFuel();
    const before = await ledger();

    await prisma.fuel.update({
      where: { id: fuelId },
      data: { odometer_photo: "odometerPhotos/new.jpg", odometer_ai_status: "verified" },
    });

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(calls).toBe(0);
    expect(row.status).toBe("SKIPPED");
    expect(row.units[0].status).toBe("RELEASED");
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });

    // The newer verdict stands.
    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } })).odometer_ai_status,
    ).toBe("verified");
  });

  it("writes nothing when the answer arrives after the photo changed", async () => {
    const { fuelId } = await queueFuel();

    pipeline.provider = fakeVision(async () => {
      // The user replaces the photo while the model is reading the old one,
      // and the newer request finishes first.
      await prisma.fuel.update({
        where: { id: fuelId },
        data: {
          odometer_photo: "odometerPhotos/replaced.jpg",
          odometer_ai_status: "verified",
          odometer_ai_reading: 1000,
        },
      });

      return odometerText({ valor_lido: 154002 });
    });

    await pipeline.runCycle();

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: fuelId } });

    // Red before: `update where id` wrote the old photo's "mismatch" over it.
    expect(fuel.odometer_ai_status).toBe("verified");
    expect(fuel.odometer_ai_reading).toBe(1000);

    expect(emitted(fuelId).some((event) => event.step === "completed")).toBe(false);
  });

  it("keeps a checklist field whose photo changed out of the verdict", async () => {
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
        photos_by_field: {
          tires_condition: ["tires-new.jpg"],
          bumpers_condition: ["bumpers.jpg"],
        },
        businessId: FLEET,
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
        businessId: FLEET,
        periodId,
        requestedById: fleet.driverUserId,
        input: {
          // The tyres' photo on the request is the OLD one.
          photosByField: {
            tires_condition: ["tires-old.jpg"],
            bumpers_condition: ["bumpers.jpg"],
          },
          checklistData: { tires_condition: "good", bumpers_condition: "good" },
        },
      },
    });

    await prisma.aIAnalysisUnit.createMany({
      data: [
        { requestId: request.id, unitKey: "tires_condition" },
        { requestId: request.id, unitKey: "bumpers_condition" },
      ],
    });

    await prisma.aIUsagePeriod.update({
      where: { id: periodId },
      data: { reservedUnits: { increment: 2 } },
    });

    const read: string[] = [];

    pipeline.provider = fakeVision(({ photoPath }) => {
      read.push(photoPath);

      return JSON.stringify({
        condicao_observada: "bad",
        confianca: 0.9,
        observacao: "dano visível",
      });
    });

    await pipeline.runCycle();

    // Only the photo still on the record was paid for.
    expect(read).toEqual(["bumpers.jpg"]);

    const settled = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(Object.keys(settled.ai_verification_details as object)).toEqual([
      "bumpers_condition",
    ]);
    expect(settled.ai_verification_details).toMatchObject({
      bumpers_condition: { status: "contradicts", observed: "bad", informed: "good" },
    });
    expect(settled.ai_verification_status).toBe("issues_found");
  });

  // Red before: the proof path called the provider first and only the card
  // write was fenced, so the old photo was paid for and charged to the quota.
  it("does not pay for a receipt proven again before the claim", async () => {
    let calls = 0;

    pipeline.provider = fakeVision(() => {
      calls += 1;
      return proofText();
    });

    const { requestId, deliveryId } = await queueProof();
    const before = await ledger();

    // Re-proof: a newer PROOF event with another photo; the card reopened.
    await prisma.deliveryEvent.create({
      data: {
        type: "PROOF",
        deliveryId,
        businessId: FLEET,
        reportedById: fleet.driverUserId,
        photo: "deliveryPhotos/reproof-before-claim.jpg",
        client_submission_id: randomUUID(),
        created_at: new Date(Date.now() + SECOND),
      },
    });

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(calls).toBe(0);
    expect(row.status).toBe("COMPLETED");
    expect(row.lastError).toMatch(/^AI_INPUT_SUPERSEDED/);
    expect(row.units[0].status).toBe("RELEASED");
    expect(await ledger()).toEqual({
      reserved: before.reserved - 1,
      consumed: before.consumed,
    });
    expect(
      (await prisma.deliveryProofAudit.findUniqueOrThrow({ where: { deliveryId } }))
        .ai_suggestion,
    ).toBeNull();

    // The reopened card waits for its new photo's reading; the quota was
    // never touched. Red before: SKIPPED read as "Limite de leituras
    // atingido" until the sweep asked for the new photo.
    expect(await aiStateOnTheQueue(deliveryId, "PENDING")).toBe("analyzing");
  });

  it("does not pay for a receipt whose card a person already decided", async () => {
    let calls = 0;

    pipeline.provider = fakeVision(() => {
      calls += 1;
      return proofText();
    });

    const { requestId, deliveryId } = await queueProof();

    await prisma.deliveryProofAudit.update({
      where: { deliveryId },
      data: { status: "APPROVED", reviewed_at: new Date() },
    });

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(calls).toBe(0);
    expect(row.status).toBe("COMPLETED");
    expect(row.units[0].status).toBe("RELEASED");

    // Red before: settled SKIPPED, which the audit queue reads as the
    // quota's refusal — an amber "Limite de leituras atingido" on a card a
    // reviewer decided during a backlog, a retry backoff or a provider pause.
    const shown = await aiStateOnTheQueue(deliveryId, "APPROVED");

    expect(shown).toBe("unavailable");
    expect(shown).not.toBe("quota_exceeded");
  });

  it("does not land on the card of a receipt proven again during the call", async () => {
    const { deliveryId, requestId } = await queueProof();

    pipeline.provider = fakeVision(async () => {
      // Re-proof while the model reads the old photo.
      await prisma.deliveryEvent.create({
        data: {
          type: "PROOF",
          deliveryId,
          businessId: FLEET,
          reportedById: fleet.driverUserId,
          photo: "deliveryPhotos/reproof.jpg",
          client_submission_id: randomUUID(),
          created_at: new Date(Date.now() + SECOND),
        },
      });

      return proofText({ e_canhoto: "nao" });
    });

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    // Red before: attached by deliveryId + PENDING alone.
    expect(card.ai_suggestion).toBeNull();

    // Paid (the call happened), and nobody is told about a photo that is gone.
    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(row.units[0].status).toBe("CONSUMED");
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(0);
  });
});

/**
 * A checklist read blind with its bumpers flagged: the photo shows them bad,
 * the driver informed good. Returns it and how many provider calls it took.
 */
async function checklistWithFlaggedBumpers() {
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
      photos_by_field: {
        tires_condition: ["tires.jpg"],
        bumpers_condition: ["bumpers-recompare.jpg"],
      },
      businessId: FLEET,
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
      businessId: FLEET,
      periodId,
      requestedById: fleet.driverUserId,
      input: {
        photosByField: {
          tires_condition: ["tires.jpg"],
          bumpers_condition: ["bumpers-recompare.jpg"],
        },
        checklistData: { tires_condition: "good", bumpers_condition: "good" },
      },
    },
  });

  await prisma.aIAnalysisUnit.createMany({
    data: [
      { requestId: request.id, unitKey: "tires_condition" },
      { requestId: request.id, unitKey: "bumpers_condition" },
    ],
  });

  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { increment: 2 } },
  });

  let calls = 0;

  pipeline.provider = fakeVision(({ photoPath }) => {
    calls += 1;

    return JSON.stringify({
      condicao_observada: photoPath === "tires.jpg" ? "good" : "bad",
      confianca: 0.9,
      observacao: "leitura",
    });
  });

  await pipeline.runCycle();

  return { checklist, calls: () => calls };
}

describe("an informed value corrected after a blind reading (AI-2)", () => {
  // Red before: the verdict was the comparison made when the reading was
  // written. A manager who corrected the informed condition after the AI
  // flagged it kept "Não confere" — the update reads only new photos, and a
  // photo already read is never paid for again.
  it("is compared again with the paid reading, without calling the provider", async () => {
    const { checklist, calls } = await checklistWithFlaggedBumpers();

    const read = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(read.ai_verification_status).toBe("issues_found");
    expect(calls()).toBe(2);

    const before = await ledger();

    // The manager agrees with the photo: the bumpers are bad. No new photo.
    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: { bumpers_condition: "bad" },
    });

    const refreshed = await refreshChecklistVerdict(checklist.id);

    expect(refreshed).toMatchObject({ written: true, changed: ["bumpers_condition"] });

    const after = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(after.ai_verification_status).toBe("verified");
    expect(after.ai_verification_details).toMatchObject({
      tires_condition: { status: "confirmed", observed: "good", informed: "good" },
      bumpers_condition: { status: "confirmed", observed: "bad", informed: "bad" },
    });

    // Nothing read, nothing charged.
    expect(calls()).toBe(2);
    expect(await ledger()).toEqual(before);

    // Asked again with nothing changed: nothing written.
    expect(await refreshChecklistVerdict(checklist.id)).toMatchObject({
      written: false,
      changed: [],
    });

    // A field whose photo changed since keeps its verdict until its own
    // reading: the paid one is about a photo the checklist no longer holds.
    await prisma.vehicleChecklist.update({
      where: { id: checklist.id },
      data: {
        tires_condition: "bad",
        photos_by_field: {
          tires_condition: ["tires-replaced.jpg"],
          bumpers_condition: ["bumpers-recompare.jpg"],
        },
      },
    });

    expect(await refreshChecklistVerdict(checklist.id)).toMatchObject({ written: false });
  });

  // Red before: the edit re-requested analysis only for new photos, and the
  // "Verificar com IA" button is hidden over issues_found, so a manager who
  // corrected the informed condition kept "Não confere" with no way out.
  it("is compared again when the manager edits the checklist, with nothing new to pay for", async () => {
    const { checklist, calls } = await checklistWithFlaggedBumpers();

    const flagged = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(flagged.ai_verification_status).toBe("issues_found");

    const before = await ledger();
    const manager = await prisma.user.findFirstOrThrow({
      where: { businessId: FLEET, role: "BUSINESS_ADMIN" },
    });

    // The manager agrees with the photo: the bumpers are bad. No new photo.
    await container
      .resolve(UpdateVehicleChecklistUseCase)
      .execute({ bumpers_condition: "bad" } as never, manager.id, checklist.id, FLEET);

    const after = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: checklist.id },
    });

    expect(after.ai_verification_status).toBe("verified");
    expect(after.ai_verification_details).toMatchObject({
      bumpers_condition: { status: "confirmed", observed: "bad", informed: "bad" },
    });

    // Nothing read, nothing charged.
    expect(calls()).toBe(2);
    expect(await ledger()).toEqual(before);
  });
});

describe("a receipt, transcribed and compared in code (decision 6.9)", () => {
  it("fills the card with what was read next to what was expected, and says 'proof'", async () => {
    const prompts: string[] = [];

    pipeline.provider = fakeVision(({ prompt }) => {
      prompts.push(prompt);
      return proofText();
    });

    const { deliveryId } = await queueProof();

    await pipeline.runCycle();

    // No invoice number, no recipient in the prompt (injection, anchoring).
    expect(prompts[0]).not.toContain("45118");
    expect(prompts[0]).not.toContain("Mercado Central");

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      reading: {
        isReceipt: "yes",
        documentMatches: "yes",
        dateVisible: "yes",
        extracted: { documentNumber: "45118", recipientName: "Maria Souza" },
        expected: { documentNumber: "45118", provenOn: "2026-09-27" },
      },
      assessment: { suggestion: "looks_good" },
    });
    expect(card.ai_confidence).toBe(0.9);

    // Red before: recordType "checklist" and no overallStatus (AI-7).
    expect(emitted(deliveryId).slice(-1)[0]).toMatchObject({
      step: "completed",
      recordType: "proof",
      overallStatus: "looks_good",
    });

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(0);
  });

  it("tells the driver, once, when the photo is not a receipt", async () => {
    pipeline.provider = fakeVision(() =>
      proofText({ e_canhoto: "nao", numero_documento_lido: null }),
    );

    const { deliveryId, requestId } = await queueProof();

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      assessment: { suggestion: "looks_wrong", failed: ["isReceipt"] },
    });

    const feedback = await prisma.domainOutboxEvent.findMany({
      where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
    });

    expect(feedback).toHaveLength(1);
    expect(feedback[0].eventKey).toBe(`delivery-proof.ai-flagged:${requestId}`);
    // Red before: the positive label, "É um canhoto de entrega", told the
    // driver the opposite of the problem.
    expect(feedback[0].payload).toMatchObject({
      driverUserId: fleet.driverUserId,
      recipientName: "Mercado Central",
      problems: ["a foto não parece um canhoto de entrega"],
      summary: "Possível problema: a foto não parece um canhoto de entrega.",
    });
  });

  it("names each problem as the problem when several failed", async () => {
    pipeline.provider = fakeVision(() =>
      proofText({ tem_assinatura: "nao", numero_documento_lido: "112907" }),
    );

    const { deliveryId } = await queueProof();

    await pipeline.runCycle();

    const [feedback] = await prisma.domainOutboxEvent.findMany({
      where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
    });

    expect(feedback.payload).toMatchObject({
      problems: [
        "não foi encontrada assinatura",
        "o número da NF-e lido não é o desta entrega",
      ],
    });

    expect(emitted(deliveryId).slice(-1)[0]).toMatchObject({
      overallStatus: "looks_wrong",
      currentResult: {
        failed: ["hasSignature", "documentMatches"],
        details:
          "Possível problema: não foi encontrada assinatura; o número da NF-e lido não é o desta entrega.",
      },
    });
  });

  // Red before: only looks_wrong reached the driver; a photo too poor to
  // read — the one that can still be retaken at the address — did not.
  it("tells the driver, once, when the photo is too poor to read", async () => {
    pipeline.provider = fakeVision(() =>
      proofText({
        e_canhoto: "nao_sei",
        legivel: "nao_sei",
        tem_assinatura: "nao_sei",
        numero_documento_lido: null,
        data_recebimento_lida: null,
        qualidade_foto: 0.1,
        confianca: 0.2,
      }),
    );

    const { deliveryId, requestId } = await queueProof();

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      assessment: { suggestion: "needs_review", failed: [] },
    });

    const feedback = await prisma.domainOutboxEvent.findMany({
      where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
    });

    expect(feedback).toHaveLength(1);
    expect(feedback[0].eventKey).toBe(`delivery-proof.ai-flagged:${requestId}`);
    expect(feedback[0].payload).toMatchObject({
      problems: ["a foto está ruim demais para leitura"],
      summary: "A foto está ruim demais para qualquer leitura automática.",
    });

    expect(emitted(deliveryId).slice(-1)[0]).toMatchObject({
      overallStatus: "needs_review",
      currentResult: { problems: ["a foto está ruim demais para leitura"] },
    });
  });

  it("does not bother the driver with a doubt the office settles", async () => {
    pipeline.provider = fakeVision(() => proofText({ data_recebimento_lida: "27/0?" }));

    const { deliveryId } = await queueProof();

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      assessment: { suggestion: "needs_review", uncertain: ["dateVisible"] },
    });
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(0);
  });

  // Red before: a request queued before decision 6.9 carried the delivery's
  // CODE as the expected document when there was no invoice; the NF-e read
  // off a good receipt "did not match" it and the driver was told so.
  it("does not compare a request queued before 6.9 with the delivery's code", async () => {
    pipeline.provider = fakeVision(() => proofText());

    const { deliveryId } = await queueProof({ invoiceNumber: null, legacyInput: true });

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      reading: { documentMatches: "not_applicable", expected: { documentNumber: null } },
      assessment: { suggestion: "looks_good" },
    });

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(0);
  });

  // Red before: every input without a version dropped its number, so the
  // card said "Sem número para conferir" for a delivery that has an NF-e.
  it("compares a request queued before 6.9 when its number is the delivery's NF-e", async () => {
    pipeline.provider = fakeVision(() => proofText({ numero_documento_lido: "112907" }));

    const { deliveryId } = await queueProof({ invoiceNumber: "45118", legacyInput: true });

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      reading: {
        documentMatches: "no",
        expected: { documentNumber: "45118" },
        extracted: { documentNumber: "112907" },
      },
      assessment: { suggestion: "looks_wrong", failed: ["documentMatches"] },
    });
  });

  it("attaches on the retry a reading paid for but not written (AI-5)", async () => {
    let calls = 0;

    pipeline.provider = fakeVision(() => {
      calls += 1;
      return proofText({ tem_assinatura: "nao" });
    });

    const { deliveryId, requestId } = await queueProof();

    // The card write fails once, after the unit was consumed. The write is an
    // `UPDATE ... RETURNING` through the transaction client's $queryRaw
    // (ai-record-store attachProofSuggestion); a spy on database.$executeRaw
    // no longer reached it, so the case passed through without a failure.
    const originalTransaction = database.$transaction.bind(database);
    let failed = false;

    const failCardWriteOnce = (tx: object) =>
      new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "$queryRaw") return Reflect.get(target, property, receiver);

          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (!failed && strings.join("?").includes('UPDATE "delivery_proof_audit"')) {
              failed = true;
              return Promise.reject(new Error("connection reset while writing the card"));
            }

            return (target as typeof database).$queryRaw(strings, ...values);
          };
        },
      });

    const spy = vi.spyOn(database, "$transaction").mockImplementation(((
      work: unknown,
      options?: unknown,
    ) =>
      typeof work === "function"
        ? originalTransaction(
            (tx: object) => (work as (client: object) => Promise<unknown>)(failCardWriteOnce(tx)),
            options as never,
          )
        : originalTransaction(work as never, options as never)) as never);

    try {
      await pipeline.runCycle();
    } finally {
      spy.mockRestore();
    }

    // The injected failure really happened (it is what this case is about).
    expect(failed).toBe(true);

    let row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(row.units[0].status).toBe("CONSUMED");
    expect(row.status).toBe("PENDING");

    await makeDue(requestId);
    await pipeline.runCycle();

    row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    // Red before: the retry saw the unit CONSUMED and finished without it.
    expect(calls).toBe(1);
    expect(row.status).toBe("COMPLETED");
    expect(card.ai_suggestion).toMatchObject({
      assessment: { suggestion: "looks_wrong", failed: ["hasSignature"] },
    });

    // The driver is told once, from the retry that wrote the card.
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      }),
    ).toBe(1);
  });

  it("counts the on-screen signature the driver collected", async () => {
    pipeline.provider = fakeVision(() => proofText({ tem_assinatura: "nao" }));

    const { deliveryId } = await queueProof({
      signature: `deliverySignatures/${FLEET}/assinatura.png`,
    });

    await pipeline.runCycle();

    const card = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(card.ai_suggestion).toMatchObject({
      reading: {
        hasSignature: "yes",
        extracted: { signatureOnPaper: "no", digitalSignature: true },
      },
      assessment: { suggestion: "looks_good" },
    });
  });
});

describe("a provider that refuses service to everybody (AI-8)", () => {
  function spendLimit() {
    return new FakeProviderError(
      429,
      "This request would exceed your organization's spend limit.",
      "rate_limit_error",
      "enforced_spend_limit_reached",
    );
  }

  function ownUsageLimit() {
    return new FakeProviderError(
      400,
      "You have reached your specified API usage limits.",
      "invalid_request_error",
    );
  }

  it.each([
    ["the spend limit (429)", spendLimit],
    ["the organisation's own usage limit (400)", ownUsageLimit],
  ])(
    "pauses the queue on %s: the attempt is given back and nothing is failed",
    async (_label, refusal) => {
      let calls = 0;

      pipeline.provider = fakeVision(() => {
        calls += 1;
        throw refusal();
      });

      const first = await queueFuel();
      const second = await queueFuel();
      const before = await ledger();

      await pipeline.runCycle();

      const rows = await prisma.aIAnalysisRequest.findMany({
        where: { id: { in: [first.requestId, second.requestId] } },
        include: { units: true },
      });

      // Red before: the 429 burnt four attempts per request and the 400
      // failed the whole queue at once.
      expect(rows.every((row) => row.status === "PENDING")).toBe(true);
      expect(rows.every((row) => row.attempts === 0)).toBe(true);
      expect(rows.every((row) => row.units[0].status === "RESERVED")).toBe(true);
      expect(rows.some((row) => row.lastError?.startsWith("AI_PROVIDER_PAUSED"))).toBe(
        true,
      );
      expect(await ledger()).toEqual(before);

      // The first refusal opened the circuit: the requests still due are not
      // claimed again until the probe.
      const callsWhenOpened = calls;
      expect(callsWhenOpened).toBeLessThanOrEqual(2);

      await pipeline.runCycle();
      expect(calls).toBe(callsWhenOpened);

      expect(pipeline.circuit.snapshot()).toMatchObject({
        state: "open",
        reason: "quota_exhausted",
      });

      // The limit is lifted; the cooldown is over (opened two hours ago).
      pipeline.circuit = new ProviderCircuit();
      pipeline.circuit.recordFailure(
        "quota_exhausted",
        new Date(Date.now() - 2 * 60 * 60 * SECOND),
      );

      pipeline.provider = fakeVision(() => odometerText());

      await pipeline.runCycle();

      // The probe went through, closed the circuit, and the rest followed.
      const settled = await prisma.aIAnalysisRequest.findMany({
        where: { id: { in: [first.requestId, second.requestId] } },
      });

      expect(settled.every((row) => row.status === "COMPLETED")).toBe(true);
      expect(pipeline.circuit.snapshot().state).toBe("closed");
    },
  );
});
