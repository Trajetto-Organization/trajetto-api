import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";

import { fakeAnalyzer } from "./support/fake-vision";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { seedProofCard } from "./support/proof-card-seed";

/**
 * New work reaching a replica whose cycle is already running (GAP2-2).
 *
 * The pool runs up to four requests at once, but a wake or a sweep that found
 * a cycle running returned at once, and the running cycle only claimed again
 * when one of its requests ENDED. One call hung on the provider (up to three
 * minutes within its budget) therefore held every request that arrived after
 * it, with three slots idle: the "one hung call stalls the replica" the
 * finding describes, only narrower.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));

const prisma = new PrismaClient();

const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  runCycle: () => Promise<void>;
  wake: () => void;
};

const CARRIER = "018fdc40-0000-7000-8000-00000000000a";

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

const USAGE = {
  provider: "fake",
  model: "test",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
};

let periodId = "";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

async function queueProof(tag: string): Promise<string> {
  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "DELIVERY_PROOF",
      recordId: await seedProofCard(prisma, {
        businessId: CARRIER,
        photoPath: `${tag}.jpg`,
      }),
      businessId: CARRIER,
      periodId,
      requestedById: randomUUID(),
      input: {
        photoPath: `${tag}.jpg`,
        signaturePath: null,
        expectedDocument: null,
        expectedRecipient: "Destinatário",
        provenOn: "2026-09-24",
      },
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "proof" },
  });

  return request.id;
}

function lastBeat(): number | undefined {
  return workerHeartbeat
    .snapshot()
    .find((entry) => entry.worker === "ai-analysis")
    ?.lastBeatAt.getTime();
}

async function statusWithin(requestId: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;

  for (;;) {
    const row = await prisma.aIAnalysisRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    if (row.status === "COMPLETED" || Date.now() > deadline) return row.status;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  // The notification pipeline is not under test.
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  const period = await prisma.aIUsagePeriod.create({
    data: {
      businessId: CARRIER,
      periodStart: quotaPeriodFor(new Date(), null).periodStart,
      reservedUnits: 10,
    },
  });

  periodId = period.id;
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("a request queued while another one hangs on the provider", () => {
  it("is analysed in a free slot now, not after the hung call ends", async () => {
    const hung = deferred();
    const hungEntered = deferred();

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async (photoPath: string) => {
        if (photoPath === "hung.jpg") {
          hungEntered.resolve();
          await hung.promise;
        }

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    const hungId = await queueProof("hung");

    const cycle = pipeline.runCycle();

    try {
      await hungEntered.promise;

      const lateId = await queueProof("late");

      // What requestAnalysis does right after its commit.
      pipeline.wake();

      expect(await statusWithin(lateId, 3_000)).toBe("COMPLETED");

      expect(
        (
          await prisma.aIAnalysisRequest.findUniqueOrThrow({
            where: { id: hungId },
          })
        ).status,
      ).toBe("PROCESSING");
    } finally {
      hung.resolve();
      await cycle;
    }

    expect(
      (
        await prisma.aIAnalysisRequest.findUniqueOrThrow({
          where: { id: hungId },
        })
      ).status,
    ).toBe("COMPLETED");
  });

  it("does not make four hung calls look like progress to the stuck detector", async () => {
    const hung = deferred();
    let entered = 0;
    const allEntered = deferred();

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async () => {
        entered += 1;
        if (entered === 4) allEntered.resolve();

        await hung.promise;

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    for (const n of [1, 2, 3, 4]) await queueProof(`stuck-${n}`);

    const cycle = pipeline.runCycle();

    try {
      await allEntered.promise;

      const beatBefore = lastBeat();

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Sweeps finding every slot taken: nothing moved, so no beat.
      await pipeline.runCycle();
      await pipeline.runCycle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(lastBeat()).toBe(beatBefore);
    } finally {
      hung.resolve();
      await cycle;
    }
  });

  it("is picked up by the sweep too, which also found the cycle running", async () => {
    const hung = deferred();
    const hungEntered = deferred();

    pipeline.provider = fakeAnalyzer({
      analyzeDeliveryProof: async (photoPath: string) => {
        if (photoPath === "hung-2.jpg") {
          hungEntered.resolve();
          await hung.promise;
        }

        return { parsed: PROOF_ANSWER, usage: USAGE };
      },
    });

    await queueProof("hung-2");

    const cycle = pipeline.runCycle();

    try {
      await hungEntered.promise;

      const lateId = await queueProof("late-2");

      // The sweep's timer calls the cycle directly.
      await pipeline.runCycle();

      expect(await statusWithin(lateId, 3_000)).toBe("COMPLETED");
    } finally {
      hung.resolve();
      await cycle;
    }
  });
});
