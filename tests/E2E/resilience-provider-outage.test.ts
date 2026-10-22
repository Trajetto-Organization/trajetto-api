import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { FakeProvider } from "./support/fake-provider";
import {
  startPipelineReplica,
  type PipelineReplica,
} from "./support/pipeline-replica-process";
import {
  makeRetriesDue,
  openWork,
  publishAccountPayables,
  queueWebhookRows,
  seedResilienceTenant,
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";

/**
 * A provider that is down, and one that is slow — contract §11 case B and
 * the "provider unavailable" column of §11 — with a real replica process.
 *
 *  - An outage must not become a retry storm: one call per row per attempt,
 *    the next attempt pushed out by the schedule WITH jitter (rows failed in
 *    the same second must not come back in the same second), and a hard
 *    ceiling of attempts, after which the row is FAILED — the dead letter a
 *    master can replay — never retried forever.
 *  - A receiver slower than our timeout (case B): we stop waiting, the
 *    receiver finishes anyway, and the retry carries the same event id, so
 *    the receiver deduplicates what it already processed.
 */
const prisma = new PrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fea00-0000-7000-8000-0000000000a1";

let seed: ResilienceSeed;
const replicas: PipelineReplica[] = [];

beforeAll(async () => {
  await fake.listen();
  seed = await seedResilienceTenant(prisma, BUSINESS);

  // E-mail only: the outage under test is one provider's.
  await prisma.user.update({
    where: { id: seed.adminId },
    data: { whatsapp_notifications_enabled: false },
  });
}, 60_000);

beforeEach(async () => {
  fake.reset();

  await prisma.webhookDelivery.deleteMany({});
  await prisma.webhookEndpoint.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  await Promise.allSettled(replicas.map((replica) => replica.kill()));
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

/**
 * Waits until all `expected` rows exist and each has been tried `attempts`
 * times and is back in the queue (or done). Counting the rows matters: an
 * empty answer (the outbox not expanded yet) satisfies every row.
 */
async function waitForAttempt(
  rows: () => Promise<Array<{ status: string; attempts: number }>>,
  attempts: number,
  what: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const current = await rows();

    if (
      current.length === expected &&
      current.every(
        (row) => row.attempts >= attempts && row.status !== "PROCESSING",
      )
    ) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `${what}: ${JSON.stringify(current.map((row) => `${row.status}:${row.attempts}`))}`,
      );
    }

    await new Promise((done) => setTimeout(done, 200));
  }
}

describe("an e-mail provider that is down (provider outage)", () => {
  it(
    "is called once per row per attempt, spread by jitter, and gives up at the ceiling",
    { timeout: 300_000 },
    async () => {
      const ROWS = 30;

      await publishAccountPayables(prisma, seed, ROWS);

      fake.behave("email", () => ({ kind: "status", status: 503 }));

      replicas.push(
        await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["notifications"],
        }),
      );

      const emails = () =>
        prisma.notificationDelivery.findMany({ where: { channel: "EMAIL" } });

      await waitForAttempt(emails, 1, "a primeira tentativa", ROWS);

      const firstFailedAt = Date.now();
      const afterFirst = await emails();

      expect(afterFirst.map((row) => row.status)).toEqual(
        Array(ROWS).fill("PENDING"),
      );

      // The schedule's first step is 30 s ± 20 %: every row is out of the
      // claim's range for at least ~24 s, and they do not all come back at the
      // same instant.
      const dueIn = afterFirst.map(
        (row) => row.availableAt.getTime() - firstFailedAt,
      );

      expect(Math.min(...dueIn)).toBeGreaterThan(20_000);
      expect(Math.max(...dueIn)).toBeLessThan(37_000);
      expect(
        new Set(afterFirst.map((row) => row.availableAt.getTime())).size,
      ).toBeGreaterThan(ROWS / 2);
      expect(Math.max(...dueIn) - Math.min(...dueIn)).toBeGreaterThan(2_000);

      // No hot loop while the backoff runs: several sweeps go by, no call.
      await new Promise((done) => setTimeout(done, 3_000));
      expect(fake.callsOf("email")).toHaveLength(ROWS);

      // The outage lasts: every remaining step of the schedule, fast-forwarded.
      for (let attempt = 2; attempt <= 7; attempt += 1) {
        await makeRetriesDue(prisma);
        await waitForAttempt(emails, attempt, `a tentativa ${attempt}`, ROWS);
      }

      const final = await emails();

      expect(final.map((row) => `${row.status}:${row.attempts}`)).toEqual(
        Array(ROWS).fill("FAILED:7"),
      );
      expect(final.every((row) => row.lastError?.includes("503"))).toBe(true);

      // The ceiling holds: seven calls per row, and none after it.
      expect(fake.callsOf("email")).toHaveLength(ROWS * 7);

      await makeRetriesDue(prisma);
      await new Promise((done) => setTimeout(done, 2_000));

      expect(fake.callsOf("email")).toHaveLength(ROWS * 7);

      // In the dead letter, ready for a master's replay.
      expect((await openWork(prisma)).notification_delivery.open).toBe(0);
    },
  );
});

describe("a webhook receiver that is down", () => {
  it(
    "is retried on a jittered schedule up to its ceiling, never forever",
    { timeout: 300_000 },
    async () => {
      // Three rows: 6 attempts x 3 = 18 failures in a row, under the endpoint
      // circuit (20), so the ceiling of each row is what ends it.
      await queueWebhookRows(prisma, seed, fake.url, 1, 3);

      fake.behave("webhook", () => ({ kind: "status", status: 500 }));

      replicas.push(
        await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["webhooks"],
        }),
      );

      const rows = () => prisma.webhookDelivery.findMany();

      await waitForAttempt(rows, 1, "a primeira tentativa dos webhooks", 3);

      const first = await rows();

      expect(new Set(first.map((row) => row.availableAt.getTime())).size).toBe(
        3,
      );

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        await makeRetriesDue(prisma);
        await waitForAttempt(
          rows,
          attempt,
          `a tentativa ${attempt} dos webhooks`,
          3,
        );
      }

      const final = await rows();

      expect(final.map((row) => `${row.status}:${row.attempts}`)).toEqual(
        Array(3).fill("FAILED:6"),
      );
      expect(fake.callsOf("webhook")).toHaveLength(3 * 6);

      // Every attempt of one event carried the same event id.
      const idsPerEvent = new Map<string, Set<string>>();

      for (const call of fake.callsOf("webhook")) {
        const code = String(
          (call.body as { data?: { code?: string } }).data?.code,
        );

        idsPerEvent.set(
          code,
          (idsPerEvent.get(code) ?? new Set()).add(String(call.idempotencyKey)),
        );
      }

      expect(idsPerEvent.size).toBe(3);
      expect([...idsPerEvent.values()].every((ids) => ids.size === 1)).toBe(
        true,
      );

      // Past the ceiling, nothing is called again.
      await makeRetriesDue(prisma);
      await new Promise((done) => setTimeout(done, 2_000));

      expect(fake.callsOf("webhook")).toHaveLength(3 * 6);
    },
  );

  it(
    "is switched off after 20 failures in a row, and the rest is held without a call",
    { timeout: 300_000 },
    async () => {
      await queueWebhookRows(prisma, seed, fake.url, 2, 10);

      fake.behave("webhook", () => ({ kind: "status", status: 500 }));

      replicas.push(
        await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["webhooks"],
        }),
      );

      const rows = () => prisma.webhookDelivery.findMany();

      await waitForAttempt(rows, 1, "a primeira tentativa dos webhooks", 20);
      await makeRetriesDue(prisma);
      await waitForAttempt(rows, 2, "a segunda tentativa dos webhooks", 20);

      // Ten rows per endpoint, two rounds: twenty failures in a row each.
      const endpoints = await prisma.webhookEndpoint.findMany();

      expect(endpoints.every((endpoint) => endpoint.disabled_at !== null)).toBe(
        true,
      );

      const callsWhenSwitchedOff = fake.callsOf("webhook").length;

      // Due again, and claimed: held until the endpoint is turned back on
      // (up to 30 days), with no call and no attempt spent (WH-05).
      await makeRetriesDue(prisma);
      await new Promise((done) => setTimeout(done, 3_000));

      expect(fake.callsOf("webhook")).toHaveLength(callsWhenSwitchedOff);

      const held = await rows();
      const inAWeek = Date.now() + 7 * 24 * 60 * 60 * 1000;

      expect(
        held.every(
          (row) =>
            row.status === "PENDING" && row.availableAt.getTime() > inAWeek,
        ),
      ).toBe(true);
      expect(held.every((row) => row.attempts <= 2)).toBe(true);
    },
  );
});

describe("a webhook receiver slower than our timeout (case B)", () => {
  it(
    "is retried after the timeout with the same event id, so the receiver keeps one copy",
    { timeout: 300_000 },
    async () => {
      await queueWebhookRows(prisma, seed, fake.url, 1, 1);

      // Longer than WEBHOOK_TIMEOUT_MS (10 s): we give up; the receiver does not.
      fake.behave("webhook", () => ({ kind: "delay", ms: 12_000 }));

      replicas.push(
        await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["webhooks"],
        }),
      );

      const rows = () => prisma.webhookDelivery.findMany();

      await waitForAttempt(rows, 1, "o tempo limite do webhook", 1);

      const [timedOut] = await rows();

      expect(timedOut.status).toBe("PENDING");
      expect(timedOut.lastError).toBeTruthy();

      // The receiver now answers at once; the retry comes.
      fake.behave("webhook", () => ({ kind: "answer" }));
      await makeRetriesDue(prisma);
      await waitUntilSettled(prisma, "o webhook depois do tempo limite");

      const [settled] = await rows();

      expect(`${settled.status}:${settled.attempts}`).toBe("DELIVERED:2");

      // The receiver saw it twice, under one event id: its dedupe keeps one.
      const calls = fake.callsOf("webhook");

      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(1);
    },
  );
});
