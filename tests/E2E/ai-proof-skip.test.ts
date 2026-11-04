import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { env } from "@/env";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { createPrismaClient } from "@/shared/database/database-client";
import { requestProofAnalysis } from "@/modules/delivery/usecases/register-delivery-proof/delivery-proof-effect";
import { ListProofAuditsUseCase } from "@/modules/delivery/usecases/list-proof-audits/list-proof-audits-usecase";
import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UploadService } from "@/shared/services/upload-service";

import { seedProofCard } from "./support/proof-card-seed";

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

// Plan M7: a company with a quota of two, and one with the AI off (0).
const QUOTA_OF_TWO = "018fdc90-0000-7000-8000-0000000000b2";
const AI_OFF = "018fdc90-0000-7000-8000-0000000000b3";
const MANAGERS = {
  [QUOTA_OF_TWO]: "018fdc90-0000-7000-8000-0000000000c2",
  [AI_OFF]: "018fdc90-0000-7000-8000-0000000000c3",
} as const;

const saved = {
  url: env.AI_LOCAL_URL,
  token: env.AI_LOCAL_TOKEN,
  provider: env.AI_PROVIDER,
  workers: env.WORKERS_ENABLED,
};

function configureReader(on: boolean) {
  env.AI_PROVIDER = "local";
  env.AI_LOCAL_URL = on ? "http://127.0.0.1:9" : undefined;
  env.AI_LOCAL_TOKEN = on ? "t".repeat(40) : undefined;

  // An HTTP-only replica: a queued reading waits for the worker service
  // instead of being drained in the background of the assertions.
  env.WORKERS_ENABLED = false;
}

function restoreReader() {
  env.AI_LOCAL_URL = saved.url;
  env.AI_LOCAL_TOKEN = saved.token;
  env.AI_PROVIDER = saved.provider;
  env.WORKERS_ENABLED = saved.workers;
}

/** The company row, as the proof use case's repository reads it. */
const businessReader = {
  findBusinessById: (id: string) =>
    prisma.business.findUnique({ where: { id } }) as never,
};

/** A proof as the driver's use case leaves it: card queued, reading asked. */
async function prove(businessId: string): Promise<string> {
  const photoPath = `deliveryPhotos/${businessId}/${randomUUID()}.jpg`;

  const deliveryId = await seedProofCard(prisma as never, {
    businessId,
    photoPath,
    invoiceNumber: "45118",
  });

  // The exact call the proof use case makes after its commit. It never
  // throws: a reading that cannot be had must not fail the driver's proof.
  await expect(
    requestProofAnalysis(businessReader, {
      deliveryId,
      businessId,
      requestedById: USER,
      photoPath,
      signaturePath: null,
      delivery: { invoice_number: "45118", recipient_name: "Mercado Central" },
      provenAt: new Date(),
    }),
  ).resolves.toBeUndefined();

  return deliveryId;
}

/** What the web's proof audit queue says about the card's reading. */
async function aiStateOnTheQueue(
  businessId: keyof typeof MANAGERS,
  deliveryId: string,
): Promise<string | undefined> {
  const listed = await new ListProofAuditsUseCase(
    new UserRepository(prisma as never),
    new ProofAuditRepository(prisma as never),
    new UploadService(),
  ).execute({
    userId: MANAGERS[businessId],
    status: "PENDING",
    page: 1,
    pageSize: 100,
  });

  return listed.data.find((card) => card.deliveryId === deliveryId)?.aiState;
}

async function seedCompany(id: string, aiLimit: number, label: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${label}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + Math.floor(Math.random() * 1_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${label.toLowerCase().replace(/\W/g, "-")}-${randomUUID()}@exemplo.com.br`,
      ai_analysis_limit: aiLimit,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: MANAGERS[id as keyof typeof MANAGERS],
      name: "Gestora",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: id,
    },
  });
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

  await seedCompany(QUOTA_OF_TWO, 2, "Cota de Dois");
  await seedCompany(AI_OFF, 0, "Sem IA");
}, 60_000);

afterEach(() => {
  restoreReader();
});

afterAll(async () => {
  restoreReader();

  const companies = [BUSINESS, QUOTA_OF_TWO, AI_OFF];

  await prisma.aIAnalysisRequest.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.aIUsagePeriod.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [USER, ...Object.values(MANAGERS)] } },
  });
  await prisma.business.deleteMany({ where: { id: { in: companies } } });
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

/**
 * The AI limit end to end (plan M7, S18): with a quota of N, N proofs are
 * read and the next one is accepted WITHOUT a reading — never refused, never
 * a failure for the driver — and the proof audit queue says why there is no
 * suggestion ("limite atingido"), not that one is on its way.
 */
describe("a company's AI quota, proof by proof (M7)", () => {
  it("reads N proofs, then takes the next one unread and says the limit was reached", async () => {
    configureReader(true);

    const first = await prove(QUOTA_OF_TWO);
    const second = await prove(QUOTA_OF_TWO);
    const third = await prove(QUOTA_OF_TWO);

    const requests = await prisma.aIAnalysisRequest.findMany({
      where: { businessId: QUOTA_OF_TWO, type: "DELIVERY_PROOF" },
      include: { units: true },
    });

    const statusOf = (deliveryId: string) =>
      requests.find((request) => request.recordId === deliveryId)?.status;

    expect(statusOf(first)).toBe("PENDING");
    expect(statusOf(second)).toBe("PENDING");
    expect(statusOf(third)).toBe("SKIPPED");

    expect(
      requests.find((request) => request.recordId === third)?.lastError,
    ).toBe("Limite de análises do período atingido");

    // Exactly N units spent or on their way, none for the refused proof.
    const [period] = await prisma.aIUsagePeriod.findMany({
      where: { businessId: QUOTA_OF_TWO },
    });

    expect(period.reservedUnits + period.consumedUnits).toBe(2);

    expect(await aiStateOnTheQueue(QUOTA_OF_TWO, first)).toBe("analyzing");
    expect(await aiStateOnTheQueue(QUOTA_OF_TWO, third)).toBe("quota_exceeded");
  });

  it("reads nothing at 0, and the card says the company has no AI", async () => {
    configureReader(true);

    const deliveryId = await prove(AI_OFF);

    // 0 = AI switched off (M2): not even a refused request is written.
    expect(
      await prisma.aIAnalysisRequest.count({ where: { businessId: AI_OFF } }),
    ).toBe(0);

    expect(await aiStateOnTheQueue(AI_OFF, deliveryId)).toBe("not_contracted");
  });
});
