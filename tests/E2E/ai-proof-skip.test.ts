import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { env } from "@/env";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A delivery proof the AI will not read — no provider key, or the company's
 * quota spent (INV-08, side bug).
 *
 * Both branches mark the record "skipped" so the screens show why no reading
 * came. For a proof that marking went to the CHECKLIST table with the
 * delivery's id: `vehicleChecklist.update` found nothing, threw P2025, and
 * the request rejected. The caller swallowed it, so nothing visible broke —
 * but the denial never reached the requester, every proof of a company
 * without quota logged a failure, and a spent quota looked like a crash.
 *
 * A proof has no verdict column to mark: its card is already in the review
 * queue and simply arrives without a suggestion, which is exactly what a
 * reviewer without AI should see.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fdc90-0000-7000-8000-0000000000b1";
const USER = "018fdc90-0000-7000-8000-0000000000c1";

const saved = {
  url: env.AI_LOCAL_URL,
  token: env.AI_LOCAL_TOKEN,
  provider: env.AI_PROVIDER,
};

function configureReader(on: boolean) {
  env.AI_PROVIDER = "local";
  env.AI_LOCAL_URL = on ? "http://127.0.0.1:9" : undefined;
  env.AI_LOCAL_TOKEN = on ? "t".repeat(40) : undefined;
}

function restoreReader() {
  env.AI_LOCAL_URL = saved.url;
  env.AI_LOCAL_TOKEN = saved.token;
  env.AI_PROVIDER = saved.provider;
}

function proofRequest(deliveryId: string) {
  return {
    type: "DELIVERY_PROOF" as const,
    recordId: deliveryId,
    businessId: BUSINESS,
    requestedById: USER,
    input: buildProofAnalysisInput({
      photoPath: `proofs/${deliveryId}/photo.jpg`,
      signaturePath: null,
      delivery: { invoice_number: "12345", recipient_name: "Cliente" },
      provenAt: new Date(),
    }),
  };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Sem Cota",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(70000000000000 + Math.floor(Math.random() * 1_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `sem-cota-${randomUUID()}@exemplo.com.br`,
      // Quota spent before the proof arrives: every request is denied.
      ai_analysis_limit: 0,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Motorista",
      email: `motorista-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
    },
  });
}, 60_000);

afterEach(() => {
  restoreReader();
});

afterAll(async () => {
  restoreReader();

  await prisma.aIUsagePeriod.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
});

describe("a delivery proof the AI will not read", () => {
  it("is answered 'unavailable' when the reader is not configured, without touching a checklist", async () => {
    configureReader(false);

    await expect(
      AIAnalysisService.getInstance().requestAnalysis(
        proofRequest(randomUUID()),
      ),
    ).resolves.toBe("unavailable");
  });

  it("is answered 'denied', and the denial recorded, when the company's quota is spent", async () => {
    configureReader(true);

    const deliveryId = randomUUID();

    await expect(
      AIAnalysisService.getInstance().requestAnalysis(proofRequest(deliveryId)),
    ).resolves.toBe("denied");

    const request = await prisma.aIAnalysisRequest.findFirst({
      where: { type: "DELIVERY_PROOF", recordId: deliveryId },
    });

    // "Why wasn't this read?" keeps its answer, and the reconcile sweep does
    // not ask again for a card whose request exists.
    expect(request?.status).toBe("SKIPPED");
  });
});
