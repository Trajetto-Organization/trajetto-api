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
import { createPrismaClient } from "@/shared/database/database-client";

// The phone is the only thing faked: the notification pipeline renders and
// routes for real, and what it hands Expo is recorded here.
const expo = vi.hoisted(() => ({
  sent: [] as Array<{ tokens: string[]; content: Record<string, unknown> }>,
}));

vi.mock("@/shared/notifications/push-provider", () => ({
  sendExpoPushMessages: async (
    tokens: string[],
    content: Record<string, unknown>,
  ) => {
    expo.sent.push({ tokens, content });

    return { deliveredAny: true, invalidTokens: [], tickets: [] };
  },
  fetchExpoPushReceipts: async () => [],
}));

vi.mock("@/websocket", () => ({
  sendAIVerificationEvent: vi.fn(),
  sendNotificationToUser: vi.fn(),
}));

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { sendNotificationToUser } from "@/websocket";

import { fakeVision, resetCircuit } from "./support/fake-vision";
import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { seedProofCard } from "./support/proof-card-seed";

/**
 * The driver's feedback on a receipt that looks wrong (decision 6.9), from
 * the model's answer to the driver's phone and inbox: the AI pipeline reads
 * the photo (fake model, real analyzer and rules), publishes
 * `delivery-proof.ai-flagged`, and the notification pipeline expands it with
 * the real policy and the real UserRepository and delivers it.
 *
 * The earlier proof stopped at the outbox row; the recipient resolution ran
 * only against a stubbed repository.
 */
const prisma = createPrismaClient();

const aiPipeline = AIAnalysisPipelineService.getInstance() as unknown as {
  provider: unknown;
  runCycle: () => Promise<void>;
};

const FLEET = "018fdcc0-0000-7000-8000-00000000000f";
const ELSEWHERE = "018fdcc0-0000-7000-8000-00000000000e";

let fleet: FleetDriverSeed;
let managerId = "";
let periodId = "";

function notAReceipt(): string {
  return JSON.stringify({
    e_canhoto: "nao",
    numero_documento_lido: null,
    data_recebimento_lida: null,
    tem_assinatura: "nao",
    nome_recebedor_lido: null,
    legivel: "sim",
    qualidade_foto: 0.9,
    confianca: 0.9,
    observacao: "Foto de uma caixa, não de um canhoto.",
  });
}

/** A proof whose receipt reading is queued, as the proof's commit leaves it. */
async function queueProof(requestedById: string) {
  const photo = `deliveryPhotos/${FLEET}/${randomUUID()}.jpg`;

  const deliveryId = await seedProofCard(prisma, {
    businessId: FLEET,
    photoPath: photo,
    invoiceNumber: "45118",
    reportedById: requestedById,
  });

  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "DELIVERY_PROOF",
      recordId: deliveryId,
      businessId: FLEET,
      periodId,
      requestedById,
      input: buildProofAnalysisInput({
        photoPath: photo,
        signaturePath: null,
        delivery: {
          invoice_number: "45118",
          recipient_name: "Mercado Central",
        },
        provenAt: new Date(),
        timeZone: "America/Sao_Paulo",
      }) as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "proof" },
  });

  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { increment: 1 } },
  });

  return deliveryId;
}

async function drainNotifications(): Promise<void> {
  const notifications = NotificationPipelineService.getInstance();

  await notifications.runOutboxCycle();
  await notifications.runDeliveryCycle("internal");
  await notifications.runDeliveryCycle("external");
}

beforeAll(async () => {
  // Both pipelines are driven one cycle at a time below.
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "62777888000190",
  });

  await seedFleetDriver(prisma, {
    businessId: ELSEWHERE,
    cnpj: "62777888000271",
  });

  managerId = (
    await prisma.user.findFirstOrThrow({
      where: { businessId: FLEET, role: "BUSINESS_ADMIN" },
    })
  ).id;

  // Both have the app: only one of them may hear about this receipt.
  await prisma.pushDeviceToken.createMany({
    data: [
      {
        userId: fleet.driverUserId,
        token: "ExponentPushToken[driver]",
        platform: "android",
      },
      {
        userId: managerId,
        token: "ExponentPushToken[manager]",
        platform: "android",
      },
    ],
  });

  periodId = (
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: FLEET,
        periodStart: quotaPeriodFor(new Date(), null).periodStart,
      },
    })
  ).id;
}, 90_000);

beforeEach(() => {
  resetCircuit(aiPipeline);
  expo.sent = [];
  vi.mocked(sendNotificationToUser).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("a receipt reading that looks wrong", () => {
  it("reaches the driver who proved it, on the phone and in the inbox, and nobody else", async () => {
    aiPipeline.provider = fakeVision(() => notAReceipt());

    const deliveryId = await queueProof(fleet.driverUserId);

    await aiPipeline.runCycle();
    await drainNotifications();

    const rows = await prisma.notification.findMany({
      where: { type: "delivery-proof-ai" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: fleet.driverUserId,
      entityId: deliveryId,
      businessId: FLEET,
      title: "Comprovante com possível problema",
    });

    // The problem said as the problem, never the positive question.
    expect(rows[0].message).toBe(
      "Entrega para Mercado Central. A leitura automática apontou: a foto não " +
        "parece um canhoto de entrega. Se ainda estiver no local, confira o " +
        "canhoto com o destinatário. A equipe vai revisar o comprovante.",
    );
    expect(rows[0].message).not.toContain("é um canhoto de entrega");

    // The live toast went to the driver's room only.
    expect(
      vi.mocked(sendNotificationToUser).mock.calls.map(([userId]) => userId),
    ).toEqual([fleet.driverUserId]);

    // One push, to the driver's phone, opening the deliveries and naming
    // the delivery. Red before: it was sent as `deliveryId`, which the
    // pipeline overwrites with the notification delivery's own id.
    expect(expo.sent).toHaveLength(1);
    expect(expo.sent[0].tokens).toEqual(["ExponentPushToken[driver]"]);
    expect(expo.sent[0].content).toMatchObject({
      title: "Comprovante com possível problema",
      body: rows[0].message,
      data: {
        url: "/deliveries",
        type: "delivery-proof.ai-flagged",
        entityId: deliveryId,
      },
    });

    // Push and in-app, never e-mail.
    const deliveries = await prisma.notificationDelivery.findMany({
      where: {
        event: { topic: "delivery-proof.ai-flagged", aggregateId: deliveryId },
      },
    });

    expect(
      deliveries
        .map(
          (row) =>
            `${row.userId === fleet.driverUserId}:${row.channel}:${row.status}`,
        )
        .sort(),
    ).toEqual(["true:IN_APP:DELIVERED", "true:PUSH:DELIVERED"]);

    // A second pass finds nothing left to send.
    await drainNotifications();

    expect(expo.sent).toHaveLength(1);
    expect(
      await prisma.notification.count({
        where: { type: "delivery-proof-ai", entityId: deliveryId },
      }),
    ).toBe(1);
  });

  it("reaches nobody when the driver moved to another company before it was sent", async () => {
    aiPipeline.provider = fakeVision(() => notAReceipt());

    const moved = await prisma.user.create({
      data: {
        name: "Motorista que saiu",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER",
        businessId: FLEET,
      },
    });

    await prisma.pushDeviceToken.create({
      data: {
        userId: moved.id,
        token: "ExponentPushToken[moved]",
        platform: "android",
      },
    });

    const deliveryId = await queueProof(moved.id);

    await aiPipeline.runCycle();

    // Between the reading and the delivery of the notice.
    await prisma.user.update({
      where: { id: moved.id },
      data: { businessId: ELSEWHERE },
    });

    await drainNotifications();

    expect(
      await prisma.notification.count({
        where: { type: "delivery-proof-ai", entityId: deliveryId },
      }),
    ).toBe(0);
    expect(expo.sent).toHaveLength(0);
  });
});
