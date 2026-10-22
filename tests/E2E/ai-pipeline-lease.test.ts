import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { seedProofCard } from "./support/proof-card-seed";
import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import {
  FakeProviderError,
  fakeAnalyzer,
  resetCircuit,
} from "./support/fake-vision";

/**
 * The AI pipeline under a slow provider and more than one replica
 * (GAP2-2, INV-09, ST-06).
 *
 * - It processed ONE request at a time per replica: two rows were claimed,
 *   the second waited with its lease running.
 * - It claimed strictly by age, so one company's 500 queued proofs put every
 *   other company's analysis 500 calls behind.
 * - The lease was set once at the claim and never renewed; a checklist whose
 *   units outlived it was re-claimed by another replica, which called the
 *   provider again for photos already being analysed.
 * - The stale owner then wrote by id alone: its FAILED landed over the new
 *   owner's COMPLETED, and it released units the new owner still held.
 * - A request whose process died mid-call was re-claimed forever, the attempt
 *   counter climbing past the retry budget.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = new PrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  runCycle: () => Promise<void>;
};

const CARRIER_A = "018fdc30-0000-7000-8000-00000000000a";
const CARRIER_B = "018fdc30-0000-7000-8000-00000000000b";
const FLEET = "018fdc30-0000-7000-8000-00000000000f";

const periods = new Map<string, string>();

let fleet: FleetDriverSeed;

const USAGE = {
  provider: "fake",
  model: "test",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
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

beforeAll(async () => {
  // The notification pipeline is not under test.
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "62777333000190",
  });
}, 60_000);

beforeEach(async () => {
  resetCircuit(pipeline);

  // Every case starts from an empty queue: a cycle drains whatever is due.
  await prisma.aIAnalysisRequest.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "COMPLETED", leaseExpiresAt: null },
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("a replica with receipts queued", () => {
  it("analyses several at once instead of one after the other", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        await sleep(200);

        inFlight -= 1;

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    const ids: string[] = [];

    for (const n of [1, 2, 3, 4]) {
      ids.push(await queueProof(CARRIER_A, `A/parallel-${n}`));
    }

    await pipeline.runCycle();

    expect(maxInFlight).toBeGreaterThanOrEqual(2);

    const settled = await prisma.aIAnalysisRequest.findMany({
      where: { id: { in: ids } },
    });

    expect(settled.every((row) => row.status === "COMPLETED")).toBe(true);
  });

  it("does not make one company's backlog wait out another's", async () => {
    const started: string[] = [];

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async (photoPath: string) => {
        started.push(photoPath);
        await sleep(20);

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    const base = Date.now() - 120_000;

    for (let n = 0; n < 10; n += 1) {
      await queueProof(CARRIER_A, `A/backlog-${n}`, {
        created_at: new Date(base + n * 1_000),
      });
    }

    // Newer than every one of A's.
    await queueProof(CARRIER_B, "B/only", {
      created_at: new Date(base + 60_000),
    });

    await pipeline.runCycle();

    expect(started).toHaveLength(11);
    expect(started.slice(0, 4)).toContain("B/only.jpg");
  });
});

describe("the fair claim", () => {
  it("ranks each company's queue off the partial fair-claim index", async () => {
    let claim: Prisma.Sql | null = null;

    const database = (await import("@/../infra/database")).default;
    const spy = vi.spyOn(database, "$queryRaw").mockImplementationOnce((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      claim = Prisma.sql(strings, ...values);
      return [];
    }) as never);

    pipeline.provider = fakeAnalyzer({});

    await pipeline.runCycle();
    spy.mockRestore();

    expect(claim).not.toBeNull();

    const captured = claim as unknown as Prisma.Sql;

    // `.text` carries Postgres placeholders ($1...); `.sql` uses `?`.
    const [, plan] = await prisma.$transaction([
      prisma.$executeRawUnsafe("SET LOCAL enable_seqscan = off"),
      prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN ${captured.text}`,
        ...captured.values,
      ),
    ]);

    const text = plan.map((line) => line["QUERY PLAN"]).join("\n");

    expect(text).toContain("ai_analysis_request_fair_claim_idx");
  });
});

describe("a stale owner, after another replica took the request over", () => {
  async function runTakenOver(failure: Error) {
    const latch = deferred();
    const entered = deferred();

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async () => {
        entered.resolve();
        await latch.promise;

        throw failure;
      },
    });

    const requestId = await queueProof(CARRIER_A, "A/stale");

    const cycle = pipeline.runCycle();

    await entered.promise;

    // The lease ran out and a newer owner claimed it and finished it.
    await prisma.aIAnalysisRequest.update({
      where: { id: requestId },
      data: {
        attempts: { increment: 1 },
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    latch.resolve();
    await cycle;

    return requestId;
  }

  it("does not put a finished request back in the queue", async () => {
    const requestId = await runTakenOver(new Error("socket hang up"));

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    expect(row.status).toBe("COMPLETED");
  });

  it("does not fail it, nor give back units it no longer holds", async () => {
    const requestId = await runTakenOver(
      new FakeProviderError(400, "invalid image"),
    );

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(row.status).toBe("COMPLETED");
    expect(row.units[0].status).toBe("RESERVED");
  });
});

describe("a request whose process kept dying mid-call", () => {
  it("is failed once the retry budget is spent, without calling the provider again", async () => {
    const provider = vi.fn(async () => ({
      parsed: PROOF_ANSWER,
      usage: USAGE,
    }));

    pipeline.provider = fakeAnalyzer({ analyzeDeliveryProof: provider });

    const requestId = await queueProof(CARRIER_A, "A/poison", {
      status: "PROCESSING",
      attempts: 4,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    await pipeline.runCycle();

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { units: true },
    });

    expect(provider).not.toHaveBeenCalled();
    expect(row.status).toBe("FAILED");
    expect(row.units[0].status).toBe("RELEASED");
  });
});

describe("a checklist whose lease is lost between two photos", () => {
  it("stops at the photo it was on instead of paying for the rest again", async () => {
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
          windshield_condition: ["windshield_condition.jpg"],
        },
        businessId: FLEET,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
      },
    });

    const fields = [
      "tires_condition",
      "bumpers_condition",
      "windshield_condition",
    ];

    const request = await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "CHECKLIST",
        recordId: checklist.id,
        businessId: FLEET,
        periodId: await periodOf(FLEET),
        requestedById: randomUUID(),
        input: {
          photosByField: Object.fromEntries(
            fields.map((f) => [f, [`${f}.jpg`]]),
          ),
          checklistData: Object.fromEntries(fields.map((f) => [f, "good"])),
        },
      },
    });

    await prisma.aIAnalysisUnit.createMany({
      data: fields.map((unitKey) => ({ requestId: request.id, unitKey })),
    });

    let calls = 0;

    pipeline.provider = fakeAnalyzer({
      analyzeChecklistImage: async () => {
        calls += 1;

        // While this photo is analysed, the lease runs out and another
        // replica claims the request.
        await prisma.aIAnalysisRequest.update({
          where: { id: request.id },
          data: { attempts: { increment: 1 } },
        });

        return {
          parsed: {
            condicao_observada: "good",
            confianca: 0.9,
            observacao: "ok",
          },
          usage: USAGE,
        };
      },
    });

    await pipeline.runCycle();

    expect(calls).toBe(1);

    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { units: true },
    });

    // Left to the new owner, as it left it.
    expect(row.status).toBe("PROCESSING");
    expect(row.units.filter((unit) => unit.status === "RESERVED")).toHaveLength(
      2,
    );
  });
});
