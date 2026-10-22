import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

// The sweep does nothing without a provider key (dev), which is right: the
// request would only be marked unavailable. Here the key "exists" and the
// request itself is spied, so no provider is ever called.
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
import { PROOF_INPUT_VERSION } from "@/shared/ai/ai-types";
import { reconcileProofAnalysisJob } from "@/jobs/cron/reconcile-proof-analysis-job";
import { businessDateKey } from "@/shared/time/business-day";

/**
 * A proven delivery whose AI reading was never requested (IDEMP-08).
 *
 * The review card commits with the proof (INV-08), but the request for the
 * model's reading still runs after the commit, with its errors swallowed: a
 * pool timeout or a crash in between leaves a card that will never carry a
 * suggestion, on a company that paid for one, and the app's resend cannot
 * heal it — a known submission returns before any side effect. The sweep
 * finds those cards and asks again, with the same input the proof would have
 * sent, so the request's idempotency key is the one the proof would have used.
 */
const prisma = new PrismaClient();

const WITH_AI = "018fdc80-0000-7000-8000-00000000000a";
const WITHOUT_AI = "018fdc80-0000-7000-8000-00000000000b";

const MINUTE = 60 * 1000;

/**
 * How long ago it was 23:30 in Manaus (03:30 UTC), at least 20 minutes back:
 * an instant whose day is already the next one in São Paulo, so a sweep that
 * dropped the company's zone gives a different provenOn every time.
 */
function ageOfLastManausLateEvening(): number {
  const now = Date.now();
  const at = new Date(now);
  at.setUTCHours(3, 30, 0, 0);

  let instant = at.getTime();
  if (instant > now - 20 * MINUTE) instant -= 24 * 60 * MINUTE;

  return now - instant;
}

let seq = 0;

async function seedBusiness(id: string, aiLimit: number, timezone?: string) {
  seq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(
        60000000000000 + seq * 1000 + Math.floor(Math.random() * 900),
      ),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      ai_analysis_limit: aiLimit,
      ...(timezone && { timezone }),
    },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: id },
  });

  const driverUser = await prisma.user.create({
    data: {
      name: "Motorista",
      email: `${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: id,
    },
  });

  return { shipperId: shipper.id, driverUserId: driverUser.id };
}

let withAI: Awaited<ReturnType<typeof seedBusiness>>;
let withoutAI: Awaited<ReturnType<typeof seedBusiness>>;

/** A DELIVERED delivery with its PROOF event and its PENDING card. */
async function provenDelivery(
  businessId: string,
  seedData: { shipperId: string; driverUserId: string },
  cardAgeMs: number,
) {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      invoice_number: "1234",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId,
      shipperId: seedData.shipperId,
      status: "DELIVERED",
      delivered_at: new Date(Date.now() - cardAgeMs),
    },
  });

  const photo = `deliveryPhotos/${businessId}/${randomUUID()}.jpg`;
  const provenAt = new Date(Date.now() - cardAgeMs);

  await prisma.deliveryEvent.create({
    data: {
      type: "PROOF",
      deliveryId: delivery.id,
      businessId,
      reportedById: seedData.driverUserId,
      photo,
      signature: null,
      client_submission_id: randomUUID(),
      occurred_at: provenAt,
      created_at: provenAt,
    },
  });

  await prisma.deliveryProofAudit.create({
    data: {
      deliveryId: delivery.id,
      businessId,
      created_at: new Date(Date.now() - cardAgeMs),
      updated_at: new Date(Date.now() - cardAgeMs),
    },
  });

  return { deliveryId: delivery.id, photo, provenAt };
}

beforeAll(async () => {
  // Manaus (UTC-4): the day the receipt is compared with is the company's
  // (DLVP-PROOF-4), not São Paulo's nor UTC's.
  withAI = await seedBusiness(WITH_AI, 10, "America/Manaus");
  withoutAI = await seedBusiness(WITHOUT_AI, 0);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the proof analysis sweep", () => {
  it("asks again for a card left without a request, with the proof's own input", async () => {
    const lost = await provenDelivery(
      WITH_AI,
      withAI,
      ageOfLastManausLateEvening(),
    );

    // Already asked: the pipeline owns it, whatever its status.
    const asked = await provenDelivery(WITH_AI, withAI, 20 * MINUTE);
    const period = await prisma.aIUsagePeriod.create({
      data: { businessId: WITH_AI, periodStart: new Date("2026-09-01") },
    });
    await prisma.aIAnalysisRequest.create({
      data: {
        periodId: period.id,
        idempotencyKey: `test-${randomUUID()}`,
        type: "DELIVERY_PROOF",
        recordId: asked.deliveryId,
        businessId: WITH_AI,
        requestedById: withAI.driverUserId,
        input: { photoPath: asked.photo },
        status: "SKIPPED",
        completedAt: new Date(),
      },
    });

    // Too fresh: the proof's own post-commit request may still be on its way.
    const fresh = await provenDelivery(WITH_AI, withAI, 1 * MINUTE);

    // The company did not buy the reading.
    const unpaid = await provenDelivery(WITHOUT_AI, withoutAI, 20 * MINUTE);

    const requestAnalysis = vi
      .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
      .mockResolvedValue("queued");

    await reconcileProofAnalysisJob.handler();

    const recordIds = requestAnalysis.mock.calls.map(([call]) => call.recordId);

    expect(recordIds).toContain(lost.deliveryId);
    expect(recordIds).not.toContain(asked.deliveryId);
    expect(recordIds).not.toContain(fresh.deliveryId);
    expect(recordIds).not.toContain(unpaid.deliveryId);

    const call = requestAnalysis.mock.calls.find(
      ([request]) => request.recordId === lost.deliveryId,
    )![0];

    expect(call).toEqual({
      type: "DELIVERY_PROOF",
      recordId: lost.deliveryId,
      businessId: WITH_AI,
      requestedById: withAI.driverUserId,
      input: {
        photoPath: lost.photo,
        signaturePath: null,
        expectedDocument: "1234",
        expectedRecipient: "Mercado Central",
        provenOn: businessDateKey(lost.provenAt, "America/Manaus"),
        inputVersion: PROOF_INPUT_VERSION,
      },
    });

    requestAnalysis.mockRestore();
  });

  // Red on the old sweep, which skipped any card whose delivery had a
  // request at all: the first proof's request hid the lost one of the
  // re-proof, and the new photo was never read.
  it("asks again for a re-proof whose new request was lost", async () => {
    const reproven = await provenDelivery(WITH_AI, withAI, 20 * MINUTE);

    const period = await prisma.aIUsagePeriod.findFirstOrThrow({
      where: { businessId: WITH_AI },
    });

    // The first proof was read...
    await prisma.aIAnalysisRequest.create({
      data: {
        periodId: period.id,
        idempotencyKey: `test-${randomUUID()}`,
        type: "DELIVERY_PROOF",
        recordId: reproven.deliveryId,
        businessId: WITH_AI,
        requestedById: withAI.driverUserId,
        input: { photoPath: "deliveryPhotos/first-proof.jpg" },
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    // ...and the proof on file now is another photo, with no request.
    const requestAnalysis = vi
      .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
      .mockResolvedValue("queued");

    await reconcileProofAnalysisJob.handler();

    const call = requestAnalysis.mock.calls.find(
      ([request]) => request.recordId === reproven.deliveryId,
    );

    expect(call?.[0].input).toMatchObject({ photoPath: reproven.photo });

    requestAnalysis.mockRestore();
  });

  it("leaves a card that already carries the model's reading alone", async () => {
    const analyzed = await provenDelivery(WITH_AI, withAI, 20 * MINUTE);

    await prisma.deliveryProofAudit.update({
      where: { deliveryId: analyzed.deliveryId },
      data: { ai_analyzed_at: new Date() },
    });

    const requestAnalysis = vi
      .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
      .mockResolvedValue("queued");

    await reconcileProofAnalysisJob.handler();

    expect(
      requestAnalysis.mock.calls.map(([call]) => call.recordId),
    ).not.toContain(analyzed.deliveryId);

    requestAnalysis.mockRestore();
  });
});
