import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { readLiveConsumers } from "@/shared/health/process-heartbeat";
import { createProviderCaps } from "@/shared/notifications/provider-caps";

import { uuid7Sql } from "./support/uuid7-sql";

/**
 * The providers' global caps divided by the live processes, against the
 * real process_heartbeat and the real external lane (plano-escala F3-15a;
 * decision D45).
 *
 *  - two live workers on the external lane: each takes half of
 *    WHATSAPP_GLOBAL_CONCURRENCY, and keeps it while the heartbeat cannot
 *    be read;
 *  - the lane under a cap keeps of a provider only what this process's
 *    part has room for, hands the rest back as unclaimed (no attempt
 *    spent, due now), and leaves the provider's channel out of the claim
 *    while it is at its part; the other provider's rows go on.
 */
const prisma = createPrismaClient();

type Pipeline =
  import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

interface ClaimedRow {
  id: string;
  channel: string;
}

const saved = {
  whatsapp: env.WHATSAPP_GLOBAL_CONCURRENCY,
  email: env.EMAIL_GLOBAL_CONCURRENCY,
};

/** A pipeline built after the env says which lanes are capped. */
async function newPipeline(): Promise<Pipeline> {
  const { NotificationPipelineService } =
    await import("@/shared/notifications/notification-pipeline-service");

  return new (NotificationPipelineService as unknown as new () => Pipeline)();
}

function claimOf(pipeline: Pipeline) {
  return (
    limit: number,
    busy: string[] = [],
    inFlight: Array<[string, number]> = [],
  ) =>
    (
      pipeline as unknown as {
        claimLaneRows: (
          lane: string,
          limit: number,
          caps: {
            busyProviders: ReadonlySet<string>;
            inFlight: ReadonlyMap<string, number>;
          },
        ) => Promise<ClaimedRow[]>;
      }
    ).claimLaneRows("external", limit, {
      busyProviders: new Set(busy),
      inFlight: new Map(inFlight),
    });
}

/** `count` bare due rows of a channel, oldest first by `secondsAgo`. */
async function bareRows(
  channel: "EMAIL" | "WHATSAPP",
  count: number,
  secondsAgo: number,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "notification_delivery" (
      "id", "outboxEventId", "userId", "channel", "status", "attempts",
      "availableAt", "created_at", "updated_at"
    )
    SELECT ${uuid7Sql()}, gen_random_uuid()::text, gen_random_uuid()::text,
           '${channel}', 'PENDING', 0,
           now() - make_interval(secs => ${secondsAgo} - n), now(), now()
    FROM generate_series(1, ${count}) AS n
    `,
  );
}

async function heartbeat(replica: string, queues: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "process_heartbeat" (
      "replica", "role", "app_env", "queues", "cron", "sockets",
      "started_at", "updated_at"
    ) VALUES ($1, 'worker', 'development', $2::text[], false, false, now(), now())
    `,
    replica,
    queues,
  );
}

beforeEach(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.$executeRawUnsafe(`DELETE FROM "process_heartbeat"`);
});

afterAll(async () => {
  env.WHATSAPP_GLOBAL_CONCURRENCY = saved.whatsapp;
  env.EMAIL_GLOBAL_CONCURRENCY = saved.email;

  await prisma.$disconnect();
});

describe("the divisor, from process_heartbeat", () => {
  it("gives each of two live workers half of the cap, and keeps it when the read fails", async () => {
    await heartbeat("worker-1/1", ["outbox", "internal", "external"]);
    await heartbeat("worker-2/1", ["external"]);
    // An api process that claims no lane does not count.
    await heartbeat("api-1/1", []);

    let failing = false;

    const caps = createProviderCaps({
      globals: () => ({ whatsapp: 4, email: 10, push: 0 }),
      live: async (lane) => {
        if (failing) throw new Error("heartbeat unreadable");

        return (await readLiveConsumers()).get(lane) ?? 0;
      },
      expected: () => 0,
    });

    await caps.refresh("external");

    expect(caps.divisor("external")).toBe(2);
    expect(caps.limitOf("whatsapp")).toBe(2);
    expect(caps.limitOf("email")).toBe(5);

    // The database hiccups: every worker keeps its half instead of taking
    // the whole contract.
    failing = true;
    await caps.refresh("external");

    expect(caps.limitOf("whatsapp")).toBe(2);
  });
});

describe("the external lane under a provider's cap", () => {
  it("keeps of the capped provider only what its part has room for, and hands back the rest", async () => {
    env.WHATSAPP_GLOBAL_CONCURRENCY = 1;
    env.EMAIL_GLOBAL_CONCURRENCY = 0;

    const claim = claimOf(await newPipeline());

    // Three WhatsApp messages older than two e-mails.
    await bareRows("WHATSAPP", 3, 120);
    await bareRows("EMAIL", 2, 60);

    const claimed = await claim(5);

    expect(claimed.filter((row) => row.channel === "WHATSAPP")).toHaveLength(1);
    expect(claimed.filter((row) => row.channel === "EMAIL")).toHaveLength(2);

    // The two over the part went back as never claimed: no attempt spent,
    // due now for the next claim.
    const back = await prisma.notificationDelivery.findMany({
      where: { channel: "WHATSAPP", id: { notIn: claimed.map((r) => r.id) } },
    });

    expect(back).toHaveLength(2);
    expect(
      back.every(
        (row) =>
          row.status === "PENDING" &&
          row.attempts === 0 &&
          row.availableAt.getTime() <= Date.now(),
      ),
    ).toBe(true);
  });

  it("leaves the provider's channel out while it is at its part, and the other provider's rows go on", async () => {
    env.WHATSAPP_GLOBAL_CONCURRENCY = 1;
    env.EMAIL_GLOBAL_CONCURRENCY = 0;

    const claim = claimOf(await newPipeline());

    await bareRows("WHATSAPP", 2, 120);
    await bareRows("EMAIL", 1, 60);

    // This process's WhatsApp send is on the wire.
    const claimed = await claim(5, ["whatsapp"], [["whatsapp", 1]]);

    expect(claimed.map((row) => row.channel)).toEqual(["EMAIL"]);

    const whatsapp = await prisma.notificationDelivery.findMany({
      where: { channel: "WHATSAPP" },
    });

    // Never claimed at all: nothing to hand back.
    expect(whatsapp.every((row) => row.attempts === 0)).toBe(true);
  });

  it("is the lane of before without a cap", async () => {
    env.WHATSAPP_GLOBAL_CONCURRENCY = 0;
    env.EMAIL_GLOBAL_CONCURRENCY = 0;

    const pipeline = await newPipeline();

    await bareRows("WHATSAPP", 3, 120);

    const claimed = await (
      pipeline as unknown as {
        claimLaneRows: (lane: string, limit: number) => Promise<ClaimedRow[]>;
      }
    ).claimLaneRows("external", 5);

    expect(claimed).toHaveLength(3);
  });
});
