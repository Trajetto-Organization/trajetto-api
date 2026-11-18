import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { redisClientOptions } from "@/config/redis-client-options";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  MAX_WAIT_MS,
  PENALIZE_RATE,
  TAKE_RATE,
  closeProviderRateBucket,
  emissionIntervalMs,
  providerRateBucket,
  rateKey,
  takeProviderRateCounts,
  useProviderRateNamespace,
} from "@/shared/notifications/provider-rate-bucket";

/**
 * The providers' rate bucket (plano-escala F3-15c; decision D45), the Lua
 * against a real Redis and the bucket through the real pipeline:
 *
 *  - TAKE_RATE spaces the places by the interval on Redis' clock, refuses
 *    a place past the longest wait without moving the bucket, and leaves a
 *    key that expires; PENALIZE_RATE moves it past a pause, never back;
 *  - with WHATSAPP_SENDS_PER_SECOND=5 and a fake Meta, never more than 5
 *    sends in a second, and every message still goes out;
 *  - a fake 130429 with the rate on spends no attempt: the row waits for
 *    the provider's pause, and the next send takes the row's one attempt;
 *  - with the rate off, the same 130429 is a failure as before (an
 *    attempt spent), and either way it is counted for provider-throttled.
 *
 * On keys of this run's own: the E2E Redis outlives the run and can serve
 * another one at the same time.
 */
const prisma = createPrismaClient();

const NAMESPACE = `test:${randomUUID()}:provider-rate`;

const BUSINESS = "018fc000-0000-7000-8000-0000000015d1";
const ADMIN = "018fc000-0000-7000-8000-0000000015d2";
const ACTOR = "018fc000-0000-7000-8000-0000000015d3";

type Pipeline =
  import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

let redis: Redis;
let pipeline: Pipeline;
let app: Awaited<typeof import("@/http")>["app"];

/** What the fake Meta answers next, one per call; then success. */
const meta = {
  sentAt: [] as number[],
  answers: [] as Array<Record<string, unknown>>,
};

const saved = env.WHATSAPP_SENDS_PER_SECOND;

/** A bill registered by ACTOR for ADMIN: one WhatsApp to the admin. */
async function publish(): Promise<void> {
  await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `account-payable.created:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: ACTOR,
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: ADMIN,
      },
    },
  });
}

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("internal");
  await pipeline.runDeliveryCycle("external");
}

async function whatsAppRows() {
  return prisma.notificationDelivery.findMany({
    where: { channel: "WHATSAPP", userId: ADMIN },
  });
}

/** Sends in the busiest window of `windowMs`, half-open. */
function busiestWindow(times: number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let most = 0;

  for (let first = 0; first < sorted.length; first += 1) {
    let inside = 0;

    for (let next = first; next < sorted.length; next += 1) {
      if (sorted[next] - sorted[first] < windowMs) inside += 1;
    }

    most = Math.max(most, inside);
  }

  return most;
}

beforeAll(async () => {
  redis = new Redis(
    process.env.REDIS_URL!,
    redisClientOptions("provider-rate"),
  );

  useProviderRateNamespace(NAMESPACE);

  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Taxa",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444001792",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `taxa-${randomUUID()}@example.com`,
    },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Pessoa Administradora",
      email: `taxa-admin-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  await prisma.user.create({
    data: {
      id: ACTOR,
      name: "Pessoa do Escritório",
      email: `taxa-escritorio-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  // After the app registered the real providers: the last one wins.
  container.registerInstance("MailProvider", {
    sendMail: async () => ({ messageId: "<m@example.com>" }),
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () => {
      const answer = meta.answers.shift();

      if (answer) return answer;

      meta.sentAt.push(Date.now());

      return { success: true, messageId: `wamid.${randomUUID()}` };
    },
  });

  const pipelineModule =
    await import("@/shared/notifications/notification-pipeline-service");

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  meta.sentAt = [];
  meta.answers = [];
  env.WHATSAPP_SENDS_PER_SECOND = 0;
  takeProviderRateCounts();

  const left = await redis.keys(`${NAMESPACE}:*`);

  if (left.length > 0) await redis.del(...left);

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.$executeRawUnsafe(`DELETE FROM "outbox_event_key"`);
  await prisma.notification.deleteMany({ where: { userId: ADMIN } });
});

afterAll(async () => {
  env.WHATSAPP_SENDS_PER_SECOND = saved;

  const left = await redis?.keys(`${NAMESPACE}:*`).catch(() => []);

  if (left?.length) await redis.del(...left).catch(() => undefined);

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.notification.deleteMany({
    where: { userId: { in: [ADMIN, ACTOR] } },
  });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, ACTOR] } } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await closeProviderRateBucket();
  redis?.disconnect();
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the bucket's scripts on Redis", () => {
  const key = () => rateKey(NAMESPACE, "email");

  const take = async (intervalMs: number, cost = 1) =>
    (await redis.eval(TAKE_RATE, 1, key(), intervalMs, cost, MAX_WAIT_MS)) as [
      number,
      number,
      number,
    ];

  it("spaces the places by the interval and refuses past the longest wait", async () => {
    const answers = [];

    for (let n = 0; n < 8; n += 1) answers.push(await take(200));

    const granted = answers.filter(([ok]) => ok === 1);
    const refused = answers.filter(([ok]) => ok === 0);

    // 0, 200, ..., 1000 ms from the first: six places within a second.
    expect(granted).toHaveLength(6);
    expect(refused).toHaveLength(2);

    const starts = granted.map(([, , start]) => start);

    for (let n = 1; n < starts.length; n += 1) {
      expect(starts[n] - starts[n - 1]).toBe(200);
    }

    // A refusal leaves the bucket where it was: the next place is still
    // the seventh's.
    expect(refused[0][2]).toBe(starts[5] + 200);
    expect(refused[1][2]).toBe(starts[5] + 200);

    // The key outlives the last place by a second, no more.
    const ttl = await redis.pttl(key());

    expect(ttl).toBeGreaterThan(1_000);
    expect(ttl).toBeLessThanOrEqual(2_300);
  });

  it("moves a cost of several units at once", async () => {
    const [, , first] = await take(2, 3);
    const [, , second] = await take(2);

    expect(second - first).toBe(6);
  });

  it("holds the bucket past a pause, never shortening a longer one", async () => {
    await redis.eval(PENALIZE_RATE, 1, key(), 5_000);
    await redis.eval(PENALIZE_RATE, 1, key(), 1_000);

    const [ok, wait] = await take(125);

    expect(ok).toBe(0);
    expect(wait).toBeGreaterThan(4_000);
    expect(wait).toBeLessThanOrEqual(5_000);
  });

  it("is what the runtime bucket answers through", async () => {
    env.EMAIL_REQUESTS_PER_SECOND = 8;

    try {
      const first = await providerRateBucket.take("email");
      const second = await providerRateBucket.take("email");

      expect(first).toEqual({ kind: "go", waitMs: 0, local: false });
      expect(second.kind).toBe("go");
      expect(second.kind === "go" ? second.waitMs : Number.NaN).toBeGreaterThan(
        emissionIntervalMs(8) - 20,
      );
    } finally {
      env.EMAIL_REQUESTS_PER_SECOND = 0;
    }
  });
});

describe("the rate through the pipeline", () => {
  it("sends no more than 5 in a second at 5/s, and sends them all", async () => {
    env.WHATSAPP_SENDS_PER_SECOND = 5;

    for (let n = 0; n < 12; n += 1) await publish();

    const started = Date.now();

    // Until every row is delivered: a row the bucket put off comes back
    // when its place is near.
    await vi.waitFor(
      async () => {
        await drain();

        expect((await whatsAppRows()).map((row) => row.status)).toEqual(
          Array.from({ length: 12 }, () => "DELIVERED"),
        );
      },
      { timeout: 30_000, interval: 100 },
    );

    expect(meta.sentAt).toHaveLength(12);

    // Spaced on Redis' clock by 200 ms; the event loop may start one a
    // few milliseconds late, never early, hence the allowance.
    expect(busiestWindow(meta.sentAt, 1_000 - 30)).toBeLessThanOrEqual(5);

    // 12 at 5/s: the last one starts at least 2.2 s after the first place.
    expect(Math.max(...meta.sentAt) - started).toBeGreaterThanOrEqual(
      2_200 - 30,
    );
  }, 60_000);

  it("waits a 130429 out without spending an attempt", async () => {
    env.WHATSAPP_SENDS_PER_SECOND = 5;
    meta.answers = [
      {
        success: false,
        retryable: true,
        httpStatus: 400,
        errorCode: 130429,
        message: "(#130429) Rate limit hit",
      },
    ];

    await publish();
    await drain();

    const [held] = await whatsAppRows();

    expect(meta.sentAt).toHaveLength(0);
    expect(held.status).toBe("PENDING");
    // The claim's attempt given back: the refusal was about the pace.
    expect(held.attempts).toBe(0);
    expect(held.lastError).toContain("[whatsapp http=400 code=130429]");
    expect(held.lastError).toContain("aguardando a taxa do provedor");
    expect(held.availableAt.getTime()).toBeGreaterThan(Date.now() + 500);

    // Every process is held: the next place is after the pause.
    const next = await redis.eval(
      TAKE_RATE,
      1,
      rateKey(NAMESPACE, "whatsapp"),
      200,
      1,
      0,
    );

    expect((next as number[])[0]).toBe(0);

    expect(takeProviderRateCounts()?.throttled.whatsapp).toBe(1);

    // Once due, it goes out on the row's first real attempt.
    await prisma.notificationDelivery.update({
      where: { id: held.id },
      data: { availableAt: new Date() },
    });

    await vi.waitFor(
      async () => {
        await drain();

        expect(meta.sentAt).toHaveLength(1);
      },
      { timeout: 20_000, interval: 100 },
    );

    const [sent] = await whatsAppRows();

    expect(sent.status).toBe("DELIVERED");
    expect(sent.attempts).toBe(1);
  }, 60_000);

  it("leaves a 130429 as it was with the rate off, and still counts it", async () => {
    env.WHATSAPP_SENDS_PER_SECOND = 0;
    meta.answers = [
      {
        success: false,
        retryable: true,
        httpStatus: 400,
        errorCode: 130429,
        message: "(#130429) Rate limit hit",
      },
    ];

    await publish();
    await drain();

    const [failed] = await whatsAppRows();

    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toMatch(/^\[whatsapp http=400 code=130429\]/);
    expect(failed.lastError).not.toContain("aguardando a taxa do provedor");
    expect(takeProviderRateCounts()?.throttled.whatsapp).toBe(1);

    // Nothing was paced: no key of the bucket.
    expect(await redis.keys(`${NAMESPACE}:*`)).toEqual([]);
  }, 60_000);
});
