import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { AIAnalysisProvider } from "@/shared/ai/ai-provider";
import {
  FakeImageReader,
  fakeImageLoader,
} from "@/shared/ai/testing/fake-image-reader";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { computeIdempotencyKey } from "@/shared/ai/ai-rules";

/** The period key of now, in the seeded companies' (default) zone. */
const periodStartFor = (instant: Date) => quotaPeriodFor(instant, null).periodStart;

/**
 * "Verificar novamente" on an analysis that failed (IDEMP-09).
 *
 * The revive read the terminal request without a lock, reserved quota, and
 * moved the request back to PENDING by id alone. Two tabs, two admins or a
 * client retry reviving the same analysis at once each reserved the units
 * again: the pipeline consumed them once, and the rest stayed reserved until
 * the month turned — quota the company paid for, refused as "limite
 * atingido". A revive in a new month also kept the request on the OLD
 * period, so the new month's reservation was never consumed or released.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = new PrismaClient();

const service = AIAnalysisService.getInstance() as unknown as {
  createRequest: (
    input: unknown,
    idempotencyKey: string,
    requestedUnits: number,
  ) => Promise<string>;
};

let businessSeq = 0;

async function seedBusiness(aiLimit: number): Promise<string> {
  businessSeq += 1;

  const business = await prisma.business.create({
    data: {
      corporate_reason: `Transportadora da Revisão ${businessSeq}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62888444000100 + businessSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `revisao-${randomUUID()}@exemplo.com.br`,
      ai_analysis_limit: aiLimit,
    },
  });

  return business.id;
}

/** A fuel analysis that ended FAILED, its one unit given back. */
async function failedFuelAnalysis(
  businessId: string,
  periodStart: Date,
  periodUsage: { consumedUnits?: number } = {},
) {
  const period = await prisma.aIUsagePeriod.upsert({
    where: { businessId_periodStart: { businessId, periodStart } },
    create: { businessId, periodStart, ...periodUsage },
    update: {},
  });

  const input = {
    type: "FUEL_ODOMETER" as const,
    recordId: randomUUID(),
    businessId,
    requestedById: randomUUID(),
    input: { odometerPhotoPath: "odometro.jpg", reportedMileage: 1234 },
  };

  const idempotencyKey = computeIdempotencyKey(
    input.type,
    input.recordId,
    input.input,
  );

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey,
      type: input.type,
      recordId: input.recordId,
      businessId,
      periodId: period.id,
      requestedById: input.requestedById,
      input: input.input,
      status: "FAILED",
      attempts: 4,
      completedAt: new Date(),
      lastError: "provider down",
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: {
      requestId: request.id,
      unitKey: "odometer",
      status: "RELEASED",
      releasedAt: new Date(),
    },
  });

  return { input, idempotencyKey, requestId: request.id, periodId: period.id };
}

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as { provider: unknown };
let savedProvider: unknown;

beforeAll(async () => {
  await prisma.$connect();

  // The units a revive reserves are the ones the configured reader reads
  // (ADR 0010 §5): the OCR reader's coverage, without any network.
  savedProvider = pipeline.provider;
  pipeline.provider = new AIAnalysisProvider(
    new FakeImageReader({ supports: ["proof", "odometer"] }),
    fakeImageLoader,
  );
}, 60_000);

afterAll(async () => {
  pipeline.provider = savedProvider;
  await prisma.$disconnect();
});

describe("reviving the same failed analysis from several places at once", () => {
  it("queues it once and reserves its quota once", async () => {
    const businessId = await seedBusiness(10);
    const current = periodStartFor(new Date());

    const { input, idempotencyKey, periodId } = await failedFuelAnalysis(
      businessId,
      current,
    );

    // Holds the period row, so all three revives are past their read of the
    // FAILED request before any of them can reserve: the interleaving a
    // double click lands in, made certain instead of likely.
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ai_usage_period" WHERE "id" = ${periodId} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const outcomes = await Promise.all(
      [1, 2, 3].map(() => service.createRequest(input, idempotencyKey, 1)),
    );

    await held;

    expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_running")).toHaveLength(2);

    const period = await prisma.aIUsagePeriod.findUniqueOrThrow({
      where: { id: periodId },
    });

    expect(period.reservedUnits).toBe(1);
  });
});

describe("reviving a failed analysis with the quota spent", () => {
  it("is refused and leaves the analysis exactly as it was", async () => {
    const businessId = await seedBusiness(2);

    const { input, idempotencyKey, requestId } = await failedFuelAnalysis(
      businessId,
      periodStartFor(new Date()),
      { consumedUnits: 2 },
    );

    expect(await service.createRequest(input, idempotencyKey, 1)).toBe("denied");

    const request = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    // Never PENDING with nothing reserved: the pipeline would call the
    // provider and the call would be charged to no quota.
    expect(request.status).toBe("FAILED");
    expect(request.units[0].status).toBe("RELEASED");
  });
});

describe("reviving last month's failed analysis", () => {
  it("moves it to this month's period, where its new reservation is", async () => {
    const businessId = await seedBusiness(10);

    const now = new Date();
    const thisMonth = periodStartFor(now);
    const lastMonth = new Date(
      Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1),
    );

    const { input, idempotencyKey, requestId, periodId: oldPeriodId } =
      await failedFuelAnalysis(businessId, lastMonth);

    expect(await service.createRequest(input, idempotencyKey, 1)).toBe("queued");

    const current = await prisma.aIUsagePeriod.findUniqueOrThrow({
      where: {
        businessId_periodStart: { businessId, periodStart: periodStartFor(now) },
      },
    });

    const request = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    expect(request.status).toBe("PENDING");
    expect(request.periodId).toBe(current.id);
    expect(current.reservedUnits).toBe(1);

    const old = await prisma.aIUsagePeriod.findUniqueOrThrow({
      where: { id: oldPeriodId },
    });

    expect(old.reservedUnits).toBe(0);
  });
});
