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
  budgetKey,
  createRedisGeocodingBudget,
} from "@/shared/delivery/geocoding/geocoding-budget";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";
import { createPrismaClient } from "@/shared/database/database-client";

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
 * - one run of the job claims at most its batch (20), never the backlog;
 * - DELIVERY_GEOCODING_DAILY_BUDGET is the ceiling across runs: with 25 left,
 *   the second run asks 5 and the third asks nothing.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let redis: Redis;

const CARRIER = "018fdcc0-0000-7000-8000-00000000000a";
const SHIPPER = "018fdcc0-0000-7000-8000-0000000000f1";

const ROWS = 1_000;
const DAILY_BUDGET = 25;

/**
 * The job's runs share one clock, far from today: the budget key is per UTC
 * day, and this file must not spend (or read) the day of any other test.
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

/** One run of the job, against the silent provider and the shared budget. */
function geocodingRun() {
  return new DeliveryGeocodingService(
    new DeliveryGeocodingRepository(),
    (address) =>
      geocodeAddress(address, {
        url: providerUrl,
        key: undefined,
        keyParam: "key",
        userAgent: "trajetto-test",
        // The provider never answers: each lookup ends at its timeout.
        timeoutMs: 150,
      }),
    createRedisGeocodingBudget(redis, DAILY_BUDGET),
    // The production batch; no spacing, the provider is local.
    { ...GEOCODING_RUN_DEFAULTS, spacingMs: 0 },
  ).runOnce(RUN_AT);
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
  await redis.del(budgetKey(RUN_AT));

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
  await redis?.del(budgetKey(RUN_AT)).catch(() => undefined);
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

    // The batch, never the backlog; the silent provider failed them all.
    expect(first).toMatchObject({
      claimed: GEOCODING_RUN_DEFAULTS.batchSize,
      failed: GEOCODING_RUN_DEFAULTS.batchSize,
    });
    expect(Number(await redis.get(budgetKey(RUN_AT)))).toBe(
      GEOCODING_RUN_DEFAULTS.batchSize,
    );

    // Five left in the day: the second run asks five, the third nothing.
    const second = await geocodingRun();

    expect(second).toMatchObject({
      claimed: DAILY_BUDGET - GEOCODING_RUN_DEFAULTS.batchSize,
    });

    const third = await geocodingRun();

    expect(third).toMatchObject({ claimed: 0, skipped: "BUDGET" });

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
