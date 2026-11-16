import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Redis from "ioredis";
import net from "node:net";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { redisClientOptions } from "@/config/redis-client-options";
import { importQueue } from "@/modules/import/services/import-queue";
import {
  DeliveryGeocodingService,
  GEOCODING_RUN_DEFAULTS,
} from "@/shared/delivery/geocoding/delivery-geocoding-service";
import {
  GEOCODING_SCOPES,
  createGeocodingBudget,
} from "@/shared/delivery/geocoding/geocoding-budget";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import type { GeocodingGate } from "@/shared/delivery/geocoding/geocoding-gate";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";
import { createPrismaClient } from "@/shared/database/database-client";
import { ProviderQuotaRepository } from "@/shared/services/provider-quota/provider-quota-repository";

import { geocodingTestKeys } from "./support/geocoding-test-keys";

/**
 * A spreadsheet of 1.000 rows and the geocoder (plan of 02/11/2026, E1:
 * "importação de 1.000 linhas sem bloquear o import"), on Postgres and Redis.
 *
 * The geocoder is a provider with a quota and a price, and it can hang. The
 * import must never wait for it: the queue is the delivery table itself (the
 * open deliveries without a point), drained by the geocode-deliveries job in
 * batches, within the day's budget shared by every replica. Here the
 * provider is a server that accepts the connection and never answers:
 *
 * - the import of 1.000 rows finishes with 1.000 deliveries, none with a
 *   point, none tried yet, and the provider was never even called;
 * - one run of the job claims at most its batch (20), never the backlog,
 *   and a provider that does not answer stops it after three failures in a
 *   row: the other seventeen go back unasked, with no attempt spent;
 * - DELIVERY_GEOCODING_DAILY_BUDGET is the ceiling across runs: run after
 *   run asks three more until the day's 25 are spent, and then nothing.
 *
 * The budget counts on keys of this run's own
 * (support/geocoding-test-keys.ts), never production's: Redis outlives a
 * run and can serve two at once, and another run of this file counting in
 * the same day would break the exact counts asserted here.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let redis: Redis;

const CARRIER = "018fdcc0-0000-7000-8000-00000000000a";
const SHIPPER = "018fdcc0-0000-7000-8000-0000000000f1";

const ROWS = 1_000;
const DAILY_BUDGET = 25;

const GEOCODING = geocodingTestKeys();

/**
 * The job's runs share one clock: the budget is per UTC day, and they must
 * all count in the same one.
 */
const RUN_AT = new Date("2099-03-14T12:00:00.000Z");

/** A provider that takes the connection and never answers. */
const silent = {
  server: net.createServer(),
  requests: 0,
  sockets: new Set<net.Socket>(),
};

let providerUrl = "";
let token = "";

async function seedAdmin(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Despachante",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

function csv(rows: number): string {
  const header = [
    "Destinatário",
    "CEP",
    "Cidade",
    "UF",
    "Logradouro",
    "Pedido",
  ];
  const lines = [header];

  for (let index = 1; index <= rows; index += 1) {
    lines.push([
      `Cliente ${index}`,
      "01001000",
      "São Paulo",
      "SP",
      `Rua das Flores ${index}`,
      `GEO-${index}`,
    ]);
  }

  return Buffer.from(
    lines.map((line) => line.map((cell) => `"${cell}"`).join(";")).join("\n"),
    "utf8",
  ).toString("base64");
}

/**
 * The gate open: this file is about the batch and the budget. The real one
 * grants a call a second, and with no wait between tries a run would stop
 * at the first slot refused (NO_SLOT), not at the failures.
 */
const OPEN_GATE: GeocodingGate = {
  paused: async () => false,
  pause: async () => undefined,
  takeSlot: async () => true,
};

/** The job's day as the provider_quota_day row counts it. */
async function jobDay(): Promise<number> {
  const row = await prisma.providerQuotaDay.findFirst({
    where: { provider: "geocoder", scope: GEOCODING_SCOPES.job },
  });

  return row?.used ?? 0;
}

/** One run of the job, against the silent provider and the shared budget. */
function geocodingRun() {
  return new DeliveryGeocodingService({
    repository: new DeliveryGeocodingRepository(),
    geocode: (address, query) =>
      geocodeAddress(
        address,
        {
          url: providerUrl,
          key: undefined,
          keyParam: "key",
          userAgent: "trajetto-test",
          // The provider never answers: each lookup ends at its timeout.
          timeoutMs: 150,
        },
        undefined,
        query,
      ),
    // The day in Postgres (F2-32), and the previous image's Redis copy
    // kept in step, on this run's keys.
    budget: createGeocodingBudget({
      quota: new ProviderQuotaRepository(),
      scope: GEOCODING_SCOPES.job,
      limit: () => DAILY_BUDGET,
      legacy: { redis, key: GEOCODING.keys.budget },
    }),
    gate: OPEN_GATE,
    // The production batch; no spacing, the provider is local.
    options: { ...GEOCODING_RUN_DEFAULTS, spacingMs: 0, slotWaitMs: 0 },
  }).runOnce(RUN_AT);
}

beforeAll(async () => {
  silent.server.on("connection", (socket) => {
    silent.sockets.add(socket);
    socket.on("data", () => {
      silent.requests += 1;
    });
    socket.on("error", () => {});
    socket.on("close", () => silent.sockets.delete(socket));
  });

  await new Promise<void>((done) => silent.server.listen(0, "127.0.0.1", done));

  providerUrl = `http://127.0.0.1:${(silent.server.address() as net.AddressInfo).port}`;

  redis = new Redis(
    process.env.REDIS_URL!,
    redisClientOptions("geocoding-budget"),
  );

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Planilha Grande",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000358",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  token = await seedAdmin();

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await GEOCODING.clear(redis);
  redis?.disconnect();

  for (const socket of silent.sockets) socket.destroy();
  await new Promise<void>((done) => silent.server.close(() => done()));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a spreadsheet of 1.000 rows", () => {
  it("is imported without waiting for the geocoder, every row queued for it", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: `/import/import-spreadsheet/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "carga-grande.csv",
        content: csv(ROWS),
        shipperId: SHIPPER,
      },
    });

    expect(accepted.statusCode, accepted.body).toBe(202);

    await importQueue.idle();

    const detail = await app.inject({
      method: "GET",
      url: `/import/get-import/${accepted.json().data.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(detail.json().data).toMatchObject({
      status: "COMPLETED",
      imported: ROWS,
    });

    // Not one call to the provider: the import never asks it.
    expect(silent.requests).toBe(0);

    const queued = await prisma.delivery.groupBy({
      by: ["geocode_status", "geocode_attempts", "geo_source"],
      where: { businessId: CARRIER, latitude: null, longitude: null },
      _count: { _all: true },
    });

    expect(queued).toEqual([
      {
        geocode_status: null,
        geocode_attempts: 0,
        geo_source: null,
        _count: { _all: ROWS },
      },
    ]);
  }, 120_000);

  it("is drained by the job in batches, within the day's budget", async () => {
    const first = await geocodingRun();
    const streak = GEOCODING_RUN_DEFAULTS.failureStreak;

    // The batch, never the backlog. The silent provider failed three in a
    // row, which stopped the run: the rest of the batch went back unasked.
    expect(first).toMatchObject({
      claimed: GEOCODING_RUN_DEFAULTS.batchSize,
      failed: streak,
      released: GEOCODING_RUN_DEFAULTS.batchSize - streak,
      stoppedBy: "FAILURES",
    });
    expect(Number(await redis.get(GEOCODING.keys.budget(RUN_AT)))).toBe(streak);
    // The day itself, in Postgres (F2-32).
    expect(await jobDay()).toBe(streak);

    // Run after run, three more each, until the day's budget is spent.
    const runs = [first];

    while (runs.length <= 12 && runs[runs.length - 1].skipped !== "BUDGET") {
      runs.push(await geocodingRun());
    }

    expect(runs[runs.length - 1]).toMatchObject({
      claimed: 0,
      skipped: "BUDGET",
    });
    expect(Number(await redis.get(GEOCODING.keys.budget(RUN_AT)))).toBe(
      DAILY_BUDGET,
    );
    expect(await jobDay()).toBe(DAILY_BUDGET);
    expect(runs.reduce((sum, run) => sum + run.failed, 0)).toBe(DAILY_BUDGET);

    const tried = await prisma.delivery.count({
      where: { businessId: CARRIER, geocode_attempts: { gt: 0 } },
    });

    expect(tried).toBe(DAILY_BUDGET);

    // The rest still wait in the queue, untouched, and nothing got a point.
    expect(
      await prisma.delivery.count({
        where: {
          businessId: CARRIER,
          geocode_status: null,
          geocode_attempts: 0,
        },
      }),
    ).toBe(ROWS - DAILY_BUDGET);
    expect(
      await prisma.delivery.count({
        where: { businessId: CARRIER, latitude: { not: null } },
      }),
    ).toBe(0);
  }, 60_000);
});
