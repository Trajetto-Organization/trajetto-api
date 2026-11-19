import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

import { FakeProvider } from "./support/fake-provider";
import {
  startPipelineReplica,
  type PipelineReplica,
} from "./support/pipeline-replica-process";
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
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";

/**
 * A replica stopped while its push batches are on the wire to Expo
 * (plano-escala U-06), with real processes: no push goes out twice.
 *
 * The stop is the deploy's (pipeline-replica.ts: the same path as SIGTERM,
 * through stdin so it also runs on Windows). A group claims push rows of
 * its own beside the pool's, so a stop in the middle must leave each row
 * either sent and recorded once, or back in the queue untouched — never
 * sent and handed back (the next replica sends it again), never left
 * PROCESSING until its lease runs out. A second replica then drains the
 * rest, and every phone has received each of its deliveries once, with
 * every ticket on its own delivery.
 */
const prisma = createPrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe600-0000-7000-8000-0000000000d6";

let seed: ResilienceSeed;
let drivers: PushDriver[] = [];
const replicas: PipelineReplica[] = [];

beforeAll(async () => {
  await fake.listen();

  seed = await seedResilienceTenant(prisma, BUSINESS);
  drivers = await seedPushDrivers(prisma, seed, 40);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(replicas.map((replica) => replica.kill()));
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

describe("a replica stopped in the middle of its push batches", () => {
  it(
    "sends no push twice and leaves no row stranded",
    { timeout: 300_000 },
    async () => {
      const expo = expoLedger();

      // A slow Expo: the stop lands while the first calls are on the wire.
      fake.behave("push", expo.behaviour(1_500));

      // Two routes per driver: 80 push rows, groups of five.
      await publishReleasesTo(prisma, seed, [
        ...drivers.map((driver) => driver.userId),
        ...drivers.map((driver) => driver.userId),
      ]);

      const first = await startPipelineReplica({
        fakeProviderUrl: fake.url,
        workers: ["notifications"],
        expandFirst: true,
        env: { PUSH_BATCH_SIZE: "5" },
      });
      replicas.push(first);

      await fake.waitFor(
        () => fake.callsOf("push").length > 0,
        "a primeira chamada de push no ar",
      );

      await first.stop();

      // What the stop left: each row sent and recorded on its first
      // attempt, or back in the queue with the claim undone. Nothing
      // PROCESSING, nothing failed.
      const afterStop = await prisma.notificationDelivery.findMany({
        where: { channel: "PUSH" },
      });

      expect(afterStop).toHaveLength(80);
      expect(
        afterStop
          .filter(
            (row) =>
              !(row.status === "DELIVERED" && row.attempts === 1) &&
              !(row.status === "PENDING" && row.attempts === 0),
          )
          .map((row) => `${row.status}:${row.attempts}:${row.lastError}`),
        first.output().slice(-2_000),
      ).toEqual([]);

      // The stop really came in the middle: some went, some wait.
      expect(afterStop.some((row) => row.status === "DELIVERED")).toBe(true);
      expect(afterStop.some((row) => row.status === "PENDING")).toBe(true);

      fake.behave("push", expo.behaviour());

      const second = await startPipelineReplica({
        fakeProviderUrl: fake.url,
        workers: ["notifications"],
        env: { PUSH_BATCH_SIZE: "5" },
      });
      replicas.push(second);

      try {
        await waitUntilSettled(prisma, "a segunda réplica", 180_000);
      } finally {
        await second.stop();
      }

      const rows = await prisma.notificationDelivery.findMany({
        where: { channel: "PUSH" },
      });

      expect(
        rows
          .filter((row) => row.status !== "DELIVERED" || row.attempts !== 1)
          .map((row) => `${row.status}:${row.attempts}:${row.lastError}`),
      ).toEqual([]);

      // Each phone got each of its deliveries exactly once, over both
      // replicas, and every ticket landed on its own delivery.
      const sent = pushMessagesOf(fake.callsOf("push")).map(
        (message) => `${message.data.deliveryId}|${message.to}`,
      );
      const devices = drivers.reduce(
        (sum, driver) => sum + driver.tokens.length,
        0,
      );

      expect(new Set(sent).size).toBe(sent.length);
      expect(sent).toHaveLength(devices * 2);
      expect(await ledgerTickets(prisma)).toEqual(
        [...expo.given].map(([key, id]) => `${key}|${id}`).sort(),
      );
    },
  );
});
