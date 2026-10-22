import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { quotaPeriodFor } from "@/shared/ai/ai-period";

import { FakeProvider } from "./support/fake-provider";
import { seedFleetDriver } from "./support/fleet-driver-seed";
import { freePort } from "./support/replica-process";
import {
  startPipelineReplica,
  type PipelineReplica,
} from "./support/pipeline-replica-process";
import {
  dockerFailureInjectionEnabled,
  startPostgres,
  stopPostgres,
} from "./support/resilience-containers";
import {
  expireLeases,
  makeRetriesDue,
  openWork,
  publishAccountPayables,
  queueFuelReadings,
  queueWebhookRows,
  seedResilienceTenant,
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";

/**
 * Case C of contract §11: Postgres goes away in the middle of the drain —
 * every connection of the pool terminated, new ones refused — and comes back.
 * Real database (the package's own container, stopped and started with
 * docker), real replica process, nothing restarted but the database.
 *
 * What must hold:
 *  - the replica process survives (no unhandled rejection takes it down) and
 *    resumes on its own once the database is back — no restart, no operator;
 *  - HTTP answers 503 with Retry-After during the outage (never a hang, never
 *    a 401 that would log the user out) and 200 after it;
 *  - nothing is lost: every row ends DELIVERED;
 *  - nothing stays PROCESSING once its lease runs out;
 *  - duplicates are bounded to sends the provider accepted while the
 *    database could not record them, and each one carries the identity the
 *    provider or receiver deduplicates by.
 *
 * Runs only under tests/E2E/support/resilience-run.sh, which owns the
 * containers it stops (see resilience-containers.ts).
 */
const enabled = dockerFailureInjectionEnabled();

const prisma = new PrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe700-0000-7000-8000-0000000000a1";
const AI_BUSINESS = "018fe700-0000-7000-8000-0000000000b1";

let seed: ResilienceSeed;
let replica: PipelineReplica | null = null;
let port = 0;

async function probe(
  path: string,
  token?: string,
): Promise<{
  status: number;
  ms: number;
  retryAfter: string | null;
  code: string | null;
}> {
  const startedAt = Date.now();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;

    return {
      status: response.status,
      ms: Date.now() - startedAt,
      retryAfter: response.headers.get("retry-after"),
      code: body?.code ?? null,
    };
  } catch {
    return {
      status: 0,
      ms: Date.now() - startedAt,
      retryAfter: null,
      code: null,
    };
  }
}

/** Readiness as Traefik reads it: asked again until it says yes. */
async function waitReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe("/health/readiness");

  while (last.status !== 200 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500));
    last = await probe("/health/readiness");
  }

  expect(last.status, "a réplica não voltou a ficar pronta").toBe(200);
}

beforeAll(async () => {
  if (!enabled) return;

  await fake.listen();
  seed = await seedResilienceTenant(prisma, BUSINESS);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;

  await replica?.kill();
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

describe.skipIf(!enabled)(
  "Postgres lost and back in the middle of the drain (case C)",
  () => {
    it(
      "the replica survives, answers 503 meanwhile, resumes alone and ends with every row delivered",
      { timeout: 600_000 },
      async () => {
        await publishAccountPayables(prisma, seed, 30);
        await queueWebhookRows(prisma, seed, fake.url, 2, 20);

        // Slow enough that the outage lands in the middle of the backlog.
        for (const kind of ["email", "whatsapp", "webhook"] as const) {
          fake.behave(kind, () => ({ kind: "delay", ms: 400 }));
        }

        port = await freePort();
        replica = await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["notifications", "webhooks"],
          httpPort: port,
        });

        // The probe's own client starts cold (a query engine to boot, a first
        // connection): its first answer may be the 3 s "no". Traefik asks again.
        await waitReady();
        expect(
          (await probe("/notification/preferences", seed.adminToken)).status,
        ).toBe(200);

        await fake.waitFor(() => fake.calls.length >= 10, "a drenagem começar");

        await stopPostgres();

        const callsAtOutage = fake.calls.length;

        // Longer than the quick success-record retries (250 ms + 1 s + 3 s): the
        // sends the provider accepts now are recorded by the detached retry once
        // the database is back.
        const outageStartedAt = Date.now();
        const readiness = await probe("/health/readiness");
        const session = await probe(
          "/notification/preferences",
          seed.adminToken,
        );

        await new Promise((done) =>
          setTimeout(done, Math.max(0, 6_000 - (Date.now() - outageStartedAt))),
        );

        expect(
          replica.process.exitCode,
          replica.output().slice(-2_000),
        ).toBeNull();

        // Out of rotation, quickly, and never a logout.
        expect(readiness.status).toBe(503);
        expect(readiness.ms).toBeLessThan(10_000);
        expect(session.status, JSON.stringify(session)).toBe(503);
        expect(session.retryAfter).toBe("5");
        expect(["SERVICE_UNAVAILABLE", "AUTH_SESSION_UNAVAILABLE"]).toContain(
          session.code,
        );
        expect(session.ms).toBeLessThan(15_000);

        await startPostgres();

        // Back without a restart: the same process serves again...
        await fake.waitFor(
          () => fake.calls.length > callsAtOutage + 5,
          "a mesma réplica voltar a enviar depois do Postgres voltar",
          120_000,
        );

        await waitReady();
        expect(
          (await probe("/notification/preferences", seed.adminToken)).status,
        ).toBe(200);

        // ...and drains everything it can. A send accepted during the outage is
        // recorded by the detached retry (every 10 s at most); what is still
        // PROCESSING after that (claimed but never sent) waits for its lease,
        // which the test fast-forwards instead of waiting three minutes.
        await new Promise((done) => setTimeout(done, 12_000));

        const leftBehind = await openWork(prisma);

        await expireLeases(prisma);
        await waitUntilSettled(
          prisma,
          "a drenagem depois da volta do Postgres",
          180_000,
        );

        expect(replica.process.exitCode).toBeNull();

        const deliveries = await prisma.notificationDelivery.findMany();

        expect(
          deliveries
            .filter((row) => row.status !== "DELIVERED")
            .map((row) => `${row.channel}:${row.status}:${row.lastError}`),
        ).toEqual([]);

        const webhooks = await prisma.webhookDelivery.findMany();

        expect(
          webhooks
            .filter((row) => row.status !== "DELIVERED")
            .map((row) => `${row.status}:${row.lastError}`),
        ).toEqual([]);

        // Nothing lost: every external row reached its provider...
        for (const [kind, channel] of [
          ["email", "EMAIL"],
          ["whatsapp", "WHATSAPP"],
        ] as const) {
          const ids = new Set(fake.callsOf(kind).map((call) => call.identity));

          expect(
            deliveries.filter(
              (row) => row.channel === channel && !ids.has(row.id),
            ),
          ).toEqual([]);
        }

        expect(
          new Set(fake.callsOf("webhook").map((call) => call.identity)).size,
        ).toBe(40);

        // ...and nothing goes out twice: a send the provider accepted while the
        // database was away is recorded by the replica that made it once the
        // database is back (well inside the lease), so the lease never hands it
        // to a second send. Before the detached record retry this was "bounded
        // by what was in flight" — up to 30 repeated sends.
        const repeated = [
          ...fake.repeated("email"),
          ...fake.repeated("whatsapp"),
          ...fake.repeated("webhook"),
        ];

        expect(repeated, JSON.stringify(leftBehind)).toEqual([]);

        for (const call of fake.callsOf("email"))
          expect(call.idempotencyKey).toBe(call.identity);

        // The bell and the activity trail: once per delivery even across the
        // outage (unique by delivery id).
        const bells = await prisma.notification.findMany({
          where: { userId: seed.adminId },
        });

        expect(bells).toHaveLength(30);

        // eslint-disable-next-line no-console
        console.info(
          `[resiliência] queda do Postgres: ${callsAtOutage} chamadas antes, ${fake.calls.length} no fim, ` +
            `${repeated.length} repetidas (e-mail ${fake.repeated("email").length}, WhatsApp ${fake.repeated("whatsapp").length}, webhook ${fake.repeated("webhook").length}; ${JSON.stringify(leftBehind)} presas até o lease)`,
        );
      },
    );
  },
);

describe.skipIf(!enabled)(
  "Postgres lost and back while the local OCR is reading (case C, AI)",
  () => {
    it(
      "ends every reading COMPLETED, and spends each photo's unit exactly once",
      { timeout: 600_000 },
      async () => {
        const fleet = await seedFleetDriver(prisma, {
          businessId: AI_BUSINESS,
          cnpj: "62777999000271",
        });

        await prisma.business.update({
          where: { id: AI_BUSINESS },
          data: { ai_analysis_limit: 1000 },
        });

        const period = await prisma.aIUsagePeriod.create({
          data: {
            businessId: AI_BUSINESS,
            periodStart: quotaPeriodFor(new Date(), null).periodStart,
          },
        });

        const queued = await queueFuelReadings(prisma, fleet, period.id, 12);

        fake.reset();
        // Each read takes a while: the outage lands with reads on the wire.
        fake.behave("ocr", () => ({ kind: "delay", ms: 700 }));

        await replica?.kill();
        replica = await startPipelineReplica({
          fakeProviderUrl: fake.url,
          workers: ["ai"],
        });

        await fake.waitFor(
          () => fake.callsOf("ocr").length >= 3,
          "as primeiras leituras",
        );

        await stopPostgres();
        await new Promise((done) => setTimeout(done, 6_000));

        expect(
          replica.process.exitCode,
          replica.output().slice(-2_000),
        ).toBeNull();

        await startPostgres();

        // What the outage interrupted waits for its lease (300 s here), or for
        // its retry: both fast-forwarded once the database answers again.
        await new Promise((done) => setTimeout(done, 5_000));
        await expireLeases(prisma);
        await makeRetriesDue(prisma);

        const deadline = Date.now() + 180_000;

        for (;;) {
          const open = await prisma.aIAnalysisRequest.count({
            where: {
              id: { in: queued.map((item) => item.requestId) },
              status: { in: ["PENDING", "PROCESSING"] },
            },
          });

          if (open === 0) break;
          if (Date.now() > deadline)
            throw new Error(
              `${open} leituras em aberto: ${replica.output().slice(-1_500)}`,
            );

          await expireLeases(prisma);
          await makeRetriesDue(prisma);
          await new Promise((done) => setTimeout(done, 1_000));
        }

        expect(replica.process.exitCode).toBeNull();

        const requests = await prisma.aIAnalysisRequest.findMany({
          where: { id: { in: queued.map((item) => item.requestId) } },
          include: { units: true },
        });

        expect(requests.map((request) => request.status)).toEqual(
          Array(12).fill("COMPLETED"),
        );
        expect(
          requests.flatMap((request) =>
            request.units.map((unit) => unit.status),
          ),
        ).toEqual(Array(12).fill("CONSUMED"));

        // The ledger: twelve photos, twelve units — never a second charge for a
        // read the outage made the pipeline repeat.
        const ledger = await prisma.aIUsagePeriod.findUniqueOrThrow({
          where: { id: period.id },
        });

        expect(ledger.consumedUnits).toBe(12);
        expect(ledger.reservedUnits).toBe(0);

        const fuels = await prisma.fuel.findMany({
          where: { id: { in: queued.map((item) => item.fuelId) } },
        });

        expect(
          fuels.filter((fuel) => fuel.odometer_ai_status === "pending"),
        ).toEqual([]);
      },
    );
  },
);

/**
 * The provider accepts a send while Postgres is away. Before the fix the
 * replica tried to record it for 250 ms + 1 s + 3 s — a stopped container
 * refuses the connect at once, so those were spent in four seconds — then
 * left the row PROCESSING, and when the lease ran out the WhatsApp went out
 * a second time. Now the fenced DELIVERED write keeps being retried, off the
 * batch, until shortly before the claim's 180 s lease ends.
 */
describe.skipIf(!enabled)(
  "a send the provider accepted while Postgres was away (case A meets case C)",
  () => {
    for (const outageMs of [9_000, 30_000]) {
      it(
        `is recorded once the database is back after ${outageMs / 1000} s, and never sent again`,
        { timeout: 300_000 },
        async () => {
          await prisma.notificationDelivery.deleteMany({});
          await prisma.domainOutboxEvent.deleteMany({});

          fake.reset();
          fake.behave("email", () => ({ kind: "hold" }));
          fake.behave("whatsapp", () => ({ kind: "hold" }));

          await replica?.kill();
          replica = await startPipelineReplica({
            fakeProviderUrl: fake.url,
            workers: ["notifications"],
          });

          await publishAccountPayables(prisma, seed, 1);

          await fake.waitFor(
            () =>
              fake.callsOf("email").length === 1 &&
              fake.callsOf("whatsapp").length === 1,
            "o e-mail e o WhatsApp chegarem ao provedor",
          );

          // The database goes away with both sends on the wire; then the provider
          // accepts them. The replica has a success to record and nowhere to write.
          await stopPostgres();
          fake.releaseHeld();

          // A container restart, a failover: longer than the quick retries,
          // shorter than the lease.
          await new Promise((done) => setTimeout(done, outageMs));

          expect(
            replica.process.exitCode,
            replica.output().slice(-2_000),
          ).toBeNull();

          await startPostgres();

          const deadline = Date.now() + 60_000;
          let rows = await prisma.notificationDelivery.findMany({
            where: { channel: { in: ["EMAIL", "WHATSAPP"] } },
          });

          while (
            rows.some((row) => row.status !== "DELIVERED") &&
            Date.now() < deadline
          ) {
            await new Promise((done) => setTimeout(done, 500));
            rows = await prisma.notificationDelivery.findMany({
              where: { channel: { in: ["EMAIL", "WHATSAPP"] } },
            });
          }

          // Recorded by the replica that sent, on its first attempt: no
          // PROCESSING row left for the lease, so no second WhatsApp.
          expect(
            rows
              .map((row) => `${row.channel}:${row.status}:${row.attempts}`)
              .sort(),
          ).toEqual(["EMAIL:DELIVERED:1", "WHATSAPP:DELIVERED:1"]);
          expect(rows.every((row) => row.providerMessageId)).toBe(true);

          // And nothing goes out again afterwards, whatever the lease does.
          await expireLeases(prisma);
          await new Promise((done) => setTimeout(done, 3_000));

          expect(fake.callsOf("email")).toHaveLength(1);
          expect(fake.callsOf("whatsapp")).toHaveLength(1);
          expect(replica.process.exitCode).toBeNull();
        },
      );
    }
  },
);
