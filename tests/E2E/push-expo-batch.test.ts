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

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";

vi.mock("@/websocket", () => ({
  sendNotificationToUser: vi.fn(),
}));

import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { FakeProvider } from "./support/fake-provider";
import {
  expoLedger,
  ledgerTickets,
  publishReleasesTo,
  pushMessagesOf,
  seedPushDrivers,
  type PushDriver,
} from "./support/push-batch-seed";
import {
  seedResilienceTenant,
  type ResilienceSeed,
} from "./support/resilience-seed";

/**
 * Push deliveries in batches to Expo (plano-escala U-06), through the real
 * pipeline: the claim, the group's own claim, each row's render and device
 * lookup, the call, the tickets by position, the receipts ledger and the
 * fenced settling. Only Expo is faked (a server in this process, reached
 * through the real fetch).
 *
 * With several deliveries in one call, a slip in the position map hands one
 * driver's ticket to another driver's delivery: the receipts job would then
 * prune the wrong phone, and a duplicate send would be blamed on the wrong
 * row. The fake Expo gives random ids, some phones dead, so only a mapping
 * by position comes out right: 100% of the tickets on their own delivery,
 * none lost.
 */
const prisma = createPrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe600-0000-7000-8000-0000000000c6";

let seed: ResilienceSeed;
let drivers: PushDriver[] = [];
let previousBatchSize = 1;

/** token → the user who owns the phone. */
const ownerOf = new Map<string, string>();

async function drain(): Promise<void> {
  const pipeline = NotificationPipelineService.getInstance();

  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("internal");
}

async function pushRows() {
  return prisma.notificationDelivery.findMany({ where: { channel: "PUSH" } });
}

beforeAll(async () => {
  await fake.listen();

  const realFetch = globalThis.fetch;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);

    if (url.startsWith("https://exp.host/")) {
      return realFetch(`${fake.url}${url.slice("https://exp.host".length)}`, {
        ...init,
      });
    }

    return realFetch(input, init);
  });

  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  seed = await seedResilienceTenant(prisma, BUSINESS);
  drivers = await seedPushDrivers(prisma, seed, 30);

  for (const driver of drivers) {
    for (const token of driver.tokens) ownerOf.set(token, driver.userId);
  }

  previousBatchSize = env.PUSH_BATCH_SIZE;
}, 120_000);

beforeEach(async () => {
  fake.reset();
  env.PUSH_BATCH_SIZE = 20;

  await prisma.notificationProviderReceipt.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  env.PUSH_BATCH_SIZE = previousBatchSize;
  vi.restoreAllMocks();
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

describe("push deliveries in batches to Expo", () => {
  it("send a backlog in a few calls, every ticket on its own delivery and none lost", async () => {
    // A phone of a driver with three is gone: its ticket is an error, the
    // other two of the same delivery still count.
    const dead = new Set([drivers[2].tokens[1], drivers[8].tokens[2]]);
    const expo = expoLedger(dead);

    fake.behave("push", expo.behaviour());

    await publishReleasesTo(
      prisma,
      seed,
      drivers.map((driver) => driver.userId),
    );

    await drain();

    const rows = await pushRows();

    expect(rows).toHaveLength(drivers.length);
    expect(
      rows
        .filter((row) => row.status !== "DELIVERED" || row.attempts !== 1)
        .map((row) => `${row.status}:${row.attempts}:${row.lastError}`),
    ).toEqual([]);

    const calls = fake.callsOf("push");
    const messages = pushMessagesOf(calls);

    // Batched: far fewer calls than deliveries, at least one carrying
    // several, none over Expo's 100.
    expect(calls.length).toBeLessThan(drivers.length / 2);
    expect(
      Math.max(
        ...calls.map(
          (call) =>
            new Set(pushMessagesOf([call]).map((m) => m.data.deliveryId)).size,
        ),
      ),
    ).toBeGreaterThan(1);
    for (const call of calls) {
      expect(pushMessagesOf([call]).length).toBeLessThanOrEqual(100);
    }

    // Each phone got its delivery once, and only the phones of the
    // delivery's own driver: no message crossed to another recipient.
    const userOf = new Map(rows.map((row) => [row.id, row.userId]));
    const sent = messages.map((m) => `${m.data.deliveryId}|${m.to}`);

    expect(new Set(sent).size).toBe(sent.length);
    expect(sent).toHaveLength(
      drivers.reduce((sum, driver) => sum + driver.tokens.length, 0),
    );
    for (const message of messages) {
      expect(ownerOf.get(message.to)).toBe(userOf.get(message.data.deliveryId));
      expect(message.tag).toBe(message.data.deliveryId);
    }

    // 100% of the tickets matched, 0 lost: the ledger holds exactly the
    // ids Expo gave, each under its own delivery and phone.
    expect(await ledgerTickets(prisma)).toEqual(
      [...expo.given].map(([key, id]) => `${key}|${id}`).sort(),
    );

    // The dead phones are pruned, and only they.
    const left = await prisma.pushDeviceToken.findMany({
      where: { token: { in: [...ownerOf.keys()] } },
    });

    expect(left.map((device) => device.token).sort()).toEqual(
      [...ownerOf.keys()].filter((token) => !dead.has(token)).sort(),
    );
  });

  it("puts a group back without spending an attempt when Expo answers 503", async () => {
    const live = drivers.slice(0, 12);

    fake.behave("push", () => ({
      kind: "status",
      status: 503,
      body: { errors: [{ code: "INTERNAL_SERVER_ERROR" }] },
    }));

    await publishReleasesTo(
      prisma,
      seed,
      live.map((driver) => driver.userId),
    );

    const before = Date.now();

    await drain();

    const rows = await pushRows();

    expect(rows).toHaveLength(live.length);
    expect(fake.callsOf("push").length).toBeLessThan(live.length);

    for (const row of rows) {
      // Back in the queue as it was claimed: no attempt spent, due after
      // the schedule's first step (30 s, jitter ±20%).
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(
        before + 24_000 - 1_000,
      );
      expect(row.lastError).toContain("[push http=503]");
      expect(row.lastError).toContain("sem gastar tentativa");
    }

    // Expo is back: the next pass delivers each on its first attempt.
    const expo = expoLedger();

    fake.reset();
    fake.behave("push", expo.behaviour());

    await prisma.notificationDelivery.updateMany({
      where: { channel: "PUSH" },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });

    await drain();

    expect(
      (await pushRows()).map((row) => `${row.status}:${row.attempts}`),
    ).toEqual(live.map(() => "DELIVERED:1"));
    expect(await ledgerTickets(prisma)).toEqual(
      [...expo.given].map(([key, id]) => `${key}|${id}`).sort(),
    );
  });

  it("send one call per delivery with PUSH_BATCH_SIZE 1, as before", async () => {
    env.PUSH_BATCH_SIZE = 1;

    const some = drivers.slice(0, 6);

    fake.behave("push", expoLedger().behaviour());

    await publishReleasesTo(
      prisma,
      seed,
      some.map((driver) => driver.userId),
    );

    await drain();

    const calls = fake.callsOf("push");

    expect(calls).toHaveLength(some.length);
    for (const call of calls) {
      expect(
        new Set(pushMessagesOf([call]).map((m) => m.data.deliveryId)).size,
      ).toBe(1);
    }
    expect(
      (await pushRows()).every(
        (row) => row.status === "DELIVERED" && row.attempts === 1,
      ),
    ).toBe(true);
  });
});
