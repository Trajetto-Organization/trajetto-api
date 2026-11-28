import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type pg from "pg";
import type { Prisma, PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { openReleaseClient } from "infra/scripts/release-connection";
import { createPrismaClient } from "@/shared/database/database-client";
import { databaseBusyAnswer } from "@/shared/errors/database-error-map";

/**
 * A lock wait that runs out answers 503 SERVICE_BUSY with Retry-After, not
 * 500 (plano-escala U-13).
 *
 * The runtime URL carries lock_timeout=5000, and it bounds the waits on the
 * `pg_advisory_xact_lock` keys too: one per company for delivery order
 * codes, route codes, the kanban board, the API key quota and the webhook
 * endpoint quota, one per driver for a departure. A second transaction on a
 * key that a slow first one holds waited out the ceiling and got a 500.
 *
 * Each key below is held by a transaction of this test, while the real
 * repository method asks for it on a client whose lock_timeout is 100 ms
 * (the URL's `options`, as production sets its 5 s): the second one fails
 * with Postgres' own 55P03, in the shape Prisma 7 really throws, and the
 * error map reads it as SERVICE_BUSY. A key renamed in the source would no
 * longer meet the one held here, and its case would fail. One of them goes
 * through the whole HTTP stack, to the 503 and its Retry-After.
 */
const BUSY_LOCK_TIMEOUT_MS = 100;

/** This file's database, with every lock wait bounded at 100 ms. */
function busyUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.set("options", `-c lock_timeout=${BUSY_LOCK_TIMEOUT_MS}`);

  return url.toString();
}

const busy = createPrismaClient({ log: [] }, { url: busyUrl() });

// The app's own client, put in place BEFORE anything imports
// infra/database (every import of the app is dynamic below).
(globalThis as unknown as { prisma: PrismaClient }).prisma = busy;

const prisma = createPrismaClient({ log: [] });

const CARRIER = "018fe0b1-0000-7000-8000-00000000000a";
const ADMIN = "018fe0b1-0000-7000-8000-0000000000a1";
const SHIPPER = "018fe0b1-0000-7000-8000-0000000000f1";
const DRIVER = "018fe0b1-0000-7000-8000-0000000000d1";
const ROUTE = "018fe0b1-0000-7000-8000-0000000000e1";

let app: Awaited<typeof import("@/http")>["app"];
let holder: pg.Client;
let token = "";

type Repositories = {
  delivery: InstanceType<
    (typeof import("@/modules/delivery/repositories/delivery-repository"))["DeliveryRepository"]
  >;
  route: InstanceType<
    (typeof import("@/modules/route/repositories/route-repository"))["RouteRepository"]
  >;
  kanban: InstanceType<
    (typeof import("@/modules/kanban/repositories/kanban-repository"))["KanbanRepository"]
  >;
  apiKey: InstanceType<
    (typeof import("@/modules/integration/repositories/api-key-repository"))["ApiKeyRepository"]
  >;
  webhook: InstanceType<
    (typeof import("@/modules/integration/repositories/webhook-endpoint-repository"))["WebhookEndpointRepository"]
  >;
};

let repositories: Repositories;

async function tokenFor(userId: string, businessId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

/**
 * Runs `contend` while this test's own transaction holds `key`, exactly as
 * the repositories take it. Returns what `contend` threw.
 */
async function whileHeld(
  key: string,
  contend: () => Promise<unknown>,
): Promise<unknown> {
  await holder.query("BEGIN");

  try {
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );

    return await contend().then(
      () => {
        throw new Error(`nobody waited on ${key}`);
      },
      (error: unknown) => error,
    );
  } finally {
    await holder.query("ROLLBACK");
  }
}

/** A transaction on the app's client, for the methods that take one. */
function inTransaction(
  run: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<unknown> {
  return busy.$transaction(run);
}

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  const [delivery, route, kanban, apiKey, webhook] = await Promise.all([
    import("@/modules/delivery/repositories/delivery-repository"),
    import("@/modules/route/repositories/route-repository"),
    import("@/modules/kanban/repositories/kanban-repository"),
    import("@/modules/integration/repositories/api-key-repository"),
    import("@/modules/integration/repositories/webhook-endpoint-repository"),
  ]);

  repositories = {
    delivery: new delivery.DeliveryRepository(busy),
    route: new route.RouteRepository(busy),
    kanban: new kanban.KanbanRepository(busy),
    apiKey: new apiKey.ApiKeyRepository(busy),
    webhook: new webhook.WebhookEndpointRepository(busy),
  };

  holder = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-lock-timeout-holder",
  );

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Travas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(55000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `travas-${randomUUID()}@example.com`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora das Travas",
      email: `admin-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  token = await tokenFor(ADMIN, CARRIER);
}, 120_000);

afterAll(async () => {
  await holder?.end();
  await app?.close();
  await prisma.$disconnect();
  await busy.$disconnect();
});

/** What the error map makes of a real 55P03. */
function expectLockTimeout(error: unknown): void {
  expect(databaseBusyAnswer(error)).toMatchObject({
    statusCode: 503,
    code: "SERVICE_BUSY",
    retryAfterSeconds: 2,
    reason: "lock_timeout",
    sqlState: "55P03",
  });
}

describe("each advisory lock key, held by another transaction", () => {
  it("delivery-order (the delivery's order identity)", async () => {
    expectLockTimeout(
      await whileHeld(`delivery-order:${CARRIER}:${SHIPPER}:PED-1`, () =>
        inTransaction((tx) =>
          repositories.delivery.lockOrderIdentity(
            CARRIER,
            SHIPPER,
            "PED-1",
            tx,
          ),
        ),
      ),
    );
  });

  it("route-code (the next route code of a company)", async () => {
    expectLockTimeout(
      await whileHeld(`route-code:${CARRIER}`, () =>
        inTransaction((tx) => repositories.route["nextCode"](tx, CARRIER)),
      ),
    );
  });

  it("route-driver-departure (one departure per driver)", async () => {
    expectLockTimeout(
      await whileHeld(`route-driver-departure:${DRIVER}`, () =>
        inTransaction((tx) =>
          repositories.route.assertDriverFreeToDepart(
            DRIVER,
            CARRIER,
            ROUTE,
            tx,
          ),
        ),
      ),
    );
  });

  it("kanban-board (the structure of a company's board)", async () => {
    expectLockTimeout(
      await whileHeld(`kanban-board:${CARRIER}`, () =>
        inTransaction((tx) => repositories.kanban["lockBoard"](tx, CARRIER)),
      ),
    );
  });

  it("api-key-quota (the API keys of a company)", async () => {
    expectLockTimeout(
      await whileHeld(`api-key-quota:${CARRIER}`, () =>
        repositories.apiKey.createWithinQuota(
          {
            name: "ERP",
            prefix: "tjk_live_lock",
            token_hash: randomUUID(),
            scopes: [],
            rate_limit_per_minute: 60,
            businessId: CARRIER,
          },
          5,
        ),
      ),
    );

    // The wait ran out before the count: nothing was written.
    expect(await prisma.apiKey.count({ where: { businessId: CARRIER } })).toBe(
      0,
    );
  });

  it("webhook-endpoint-quota (the webhook endpoints of a company)", async () => {
    expectLockTimeout(
      await whileHeld(`webhook-endpoint-quota:${CARRIER}`, () =>
        repositories.webhook.createWithinQuota(
          CARRIER,
          {
            name: "ERP",
            url: "https://erp.example.com/webhooks",
            secret: "lacrado",
            topics: ["delivery.created"],
            headers: null as never,
            is_active: true,
          },
          5,
        ),
      ),
    );
  });
});

describe("the real shapes of the other ceilings", () => {
  it("reads a row lock wait on a model query as SERVICE_BUSY", async () => {
    await holder.query("BEGIN");

    try {
      await holder.query(
        `SELECT 1 FROM "business" WHERE "id" = $1 FOR UPDATE`,
        [CARRIER],
      );

      const error = await busy.business
        .update({ where: { id: CARRIER }, data: { telephone: "11988887777" } })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expectLockTimeout(error);
    } finally {
      await holder.query("ROLLBACK");
    }
  });

  it("reads a statement cancelled by statement_timeout as SERVICE_BUSY", async () => {
    const error = await busy
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '100ms'");
        await tx.$queryRawUnsafe("SELECT pg_sleep(2)::text");
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(databaseBusyAnswer(error)).toMatchObject({
      code: "SERVICE_BUSY",
      reason: "statement_timeout",
      sqlState: "57014",
    });
  });
});

describe("through the whole HTTP stack", () => {
  it("answers the second creator of a webhook endpoint 503 with Retry-After", async () => {
    const response = (await whileHeld(
      `webhook-endpoint-quota:${CARRIER}`,
      async () => {
        const answer = await app.inject({
          method: "POST",
          url: `/integrations/webhook-endpoint/${CARRIER}`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: "ERP com fila",
            url: "https://erp.example.com/webhooks",
            topics: ["delivery.created"],
          },
        });

        // whileHeld wants a rejection: the answer IS the outcome here.
        throw answer;
      },
    )) as Awaited<ReturnType<typeof app.inject>>;

    expect(response.statusCode, response.body).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.headers["x-error-code"]).toBe("SERVICE_BUSY");
    expect(response.json()).toEqual({
      code: "SERVICE_BUSY",
      message: "O sistema está ocupado; tente de novo em instantes.",
      requestId: response.headers["x-request-id"],
    });
    expect(
      await prisma.webhookEndpoint.count({ where: { businessId: CARRIER } }),
    ).toBe(0);

    // The lock released, the same request goes through.
    const again = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "ERP com fila",
        url: "https://erp.example.com/webhooks",
        topics: ["delivery.created"],
      },
    });

    expect(again.statusCode, again.body).toBe(201);
  });
});
