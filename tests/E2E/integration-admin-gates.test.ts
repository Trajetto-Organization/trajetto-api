import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { fanOutWebhookEvent } from "@/shared/integration/webhook-dispatch-service";
import {
  ENDPOINT_PAUSED_REASON,
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  parkedUntil,
} from "@/shared/integration/webhook-dispatch-rules";
import { FAMILY_WILDCARDS } from "@/shared/integration/webhook-catalogue";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { businessToday, dateOnlyKey } from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The integrations admin routes, over HTTP against the real database.
 *
 * - Integrations belong to Entregas (decision 4.3, INT-MOD-1): a fleet-only
 *   company used to issue keys that always answered 403 and point webhooks
 *   that never fired.
 * - Ten endpoints per company, counted under a lock (DLVB-24).
 * - "Todos os eventos" of Documentos is three wildcards; `document.*` is
 *   refused, and a legacy one still delivers (DLVB-22).
 * - Reactivating a switched-off endpoint is its own action (decision 2.5,
 *   CRIT-24), with the tenant and role checks every write carries.
 * - "Uso da API" answers in the company's calendar (DLVB-33).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe210-0000-7000-8000-00000000000a";
const OTHER = "018fe210-0000-7000-8000-00000000000b";
const FLEET = "018fe210-0000-7000-8000-00000000000c";

const ADMIN = "018fe210-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018fe210-0000-7000-8000-0000000000a2";
const FLEET_ADMIN = "018fe210-0000-7000-8000-0000000000a3";
const READER = "018fe210-0000-7000-8000-0000000000a4";
const OUTSIDER = "018fe210-0000-7000-8000-0000000000a5";
const DRIVER_USER = "018fe210-0000-7000-8000-0000000000a6";
const DRIVER = "018fe210-0000-7000-8000-0000000000d1";
const MASTER = "018fe210-0000-7000-8000-0000000000a7";

const tokens: Record<string, string> = {};
const profiles: string[] = [];

async function tokenFor(userId: string): Promise<string> {
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
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: userId,
      expiresIn: "1h",
    },
  );
}

async function seedBusiness(
  id: string,
  modules: Array<"DELIVERIES" | "FLEET">,
  timezone = "America/Sao_Paulo",
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `integracoes-${randomUUID()}@exemplo.com.br`,
      timezone,
    },
  });

  for (const module of modules) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module, enabled: true },
    });
  }
}

async function seedUser(
  id: string,
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      name: `Pessoa ${id.slice(-2)}`,
      email: `pessoa-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role,
      businessId,
      ...extra,
    },
  });

  tokens[id] = await tokenFor(id);
}

async function seedProfile(
  businessId: string,
  permissions: Array<{ key: string; read: boolean; write: boolean }>,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 6)}`,
      businessId,
      permissions: {
        create: permissions.map((permission) => ({
          permissionKey: permission.key,
          action: "Teste",
          canRead: permission.read,
          canWrite: permission.write,
          businessId,
        })),
      },
    },
  });

  profiles.push(profile.id);

  return profile.id;
}

async function seedEndpoint(
  businessId: string,
  data: Partial<{
    topics: string[];
    is_active: boolean;
    disabled_at: Date | null;
    consecutive_failures: number;
  }> = {},
): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `ERP ${randomUUID().slice(0, 4)}`,
      url: `https://erp.exemplo.com.br/${randomUUID()}`,
      secret: "whsec_teste",
      topics: data.topics ?? ["delivery.*"],
      is_active: data.is_active ?? true,
      disabled_at: data.disabled_at ?? null,
      consecutive_failures: data.consecutive_failures ?? 0,
      businessId,
    },
  });

  return endpoint.id;
}

async function heldRow(
  businessId: string,
  endpointId: string,
): Promise<string> {
  const row = await prisma.webhookDelivery.create({
    data: {
      businessId,
      endpointId,
      topic: "delivery.created",
      payload: { id: randomUUID() },
      signature: "v1=teste",
      status: "PENDING",
      availableAt: parkedUntil(new Date()),
      lastError: ENDPOINT_PAUSED_REASON,
    },
  });

  return row.id;
}

function call(
  userId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokens[userId]}` },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

const endpointBody = (topics: string[] = ["delivery.created"]) => ({
  name: "ERP do embarcador",
  url: `https://erp.exemplo.com.br/${randomUUID()}`,
  topics,
});

beforeAll(async () => {
  await seedBusiness(CARRIER, ["DELIVERIES", "FLEET"], "America/Manaus");
  await seedBusiness(OTHER, ["DELIVERIES"]);
  await seedBusiness(FLEET, ["FLEET"]);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista das Integrações",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${randomUUID().slice(0, 8)}`,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await seedUser(ADMIN, CARRIER, "BUSINESS_ADMIN");
  await seedUser(OTHER_ADMIN, OTHER, "BUSINESS_ADMIN");
  await seedUser(FLEET_ADMIN, FLEET, "BUSINESS_ADMIN");

  await seedUser(READER, CARRIER, "BUSINESS_USER", {
    profileAccessId: await seedProfile(CARRIER, [
      { key: "integration_manage", read: true, write: false },
    ]),
  });

  await seedUser(OUTSIDER, CARRIER, "BUSINESS_USER", {
    profileAccessId: await seedProfile(CARRIER, [
      { key: "delivery_manage", read: true, write: true },
    ]),
  });

  await seedUser(DRIVER_USER, CARRIER, "BUSINESS_USER", { driverId: DRIVER });
  await seedUser(MASTER, null, "MASTER");

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  const businesses = [CARRIER, OTHER, FLEET];
  const users = [
    ADMIN,
    OTHER_ADMIN,
    FLEET_ADMIN,
    READER,
    OUTSIDER,
    DRIVER_USER,
    MASTER,
  ];

  await prisma.activity.deleteMany({
    where: { businessId: { in: businesses } },
  });
  await prisma.apiKeyUsageDaily.deleteMany({
    where: { businessId: { in: businesses } },
  });
  await prisma.apiKey.deleteMany({ where: { businessId: { in: businesses } } });
  await prisma.webhookDelivery.deleteMany({
    where: { businessId: { in: businesses } },
  });
  await prisma.webhookEndpoint.deleteMany({
    where: { businessId: { in: businesses } },
  });

  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });

  await prisma.permission.deleteMany({
    where: { profileAccessId: { in: profiles } },
  });
  await prisma.profileAccess.deleteMany({ where: { id: { in: profiles } } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: businesses } },
  });
  await prisma.business.deleteMany({ where: { id: { in: businesses } } });

  await app?.close();
  await prisma.$disconnect();
});

describe("a company without Entregas (INT-MOD-1, decision 4.3)", () => {
  /**
   * All twelve integrations routes, naming the fleet-only company. The
   * record ids are real where one exists, so a refusal can only be the gate
   * (a missing record would answer 404 instead).
   */
  async function everyRoute(query: string) {
    const endpointId = await seedEndpoint(FLEET, { disabled_at: new Date() });

    const apiKey = await prisma.apiKey.create({
      data: {
        businessId: FLEET,
        name: "Chave antiga",
        prefix: `tk_${randomUUID().slice(0, 8)}`,
        token_hash: randomUUID(),
        scopes: ["deliveries:read"],
      },
    });

    const delivery = await prisma.webhookDelivery.create({
      data: {
        businessId: FLEET,
        endpointId,
        topic: "delivery.created",
        payload: { id: randomUUID() },
        signature: "v1=teste",
        status: "FAILED",
      },
    });

    return {
      endpointId,
      routes: [
        ["GET", `/integrations/api-keys${query}`],
        ["GET", `/integrations/webhook-endpoints${query}`],
        [
          "GET",
          `/integrations/webhook-deliveries?page=1&pageSize=5${query.replace("?", "&")}`,
        ],
        ["GET", `/integrations/api-usage?days=7${query.replace("?", "&")}`],
        [
          "POST",
          `/integrations/api-key/${FLEET}`,
          { name: "ERP sem módulo", scopes: ["deliveries:read"] },
        ],
        ["DELETE", `/integrations/api-key/${apiKey.id}/business/${FLEET}`],
        ["POST", `/integrations/webhook-endpoint/${FLEET}`, endpointBody()],
        [
          "PUT",
          `/integrations/webhook-endpoint/${endpointId}/business/${FLEET}`,
          endpointBody(),
        ],
        [
          "POST",
          `/integrations/webhook-endpoint/${endpointId}/business/${FLEET}/reactivate`,
        ],
        [
          "POST",
          `/integrations/webhook-endpoint/${endpointId}/business/${FLEET}/rotate-secret`,
        ],
        [
          "DELETE",
          `/integrations/webhook-endpoint/${endpointId}/business/${FLEET}`,
        ],
        [
          "POST",
          `/integrations/webhook-delivery/${delivery.id}/business/${FLEET}/resend`,
        ],
      ] as Array<["GET" | "POST" | "PUT" | "DELETE", string, unknown?]>,
    };
  }

  async function expectUntouched(endpointId: string): Promise<void> {
    // Nothing was issued, registered, changed or removed on the way.
    expect(
      await prisma.apiKey.count({
        where: { businessId: FLEET, revoked_at: null },
      }),
    ).toBe(1);
    expect(
      await prisma.webhookEndpoint.count({ where: { businessId: FLEET } }),
    ).toBe(1);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.disabled_at).not.toBeNull();
    expect(endpoint.secret).toBe("whsec_teste");
  }

  async function cleanFleet(): Promise<void> {
    await prisma.webhookDelivery.deleteMany({ where: { businessId: FLEET } });
    await prisma.webhookEndpoint.deleteMany({ where: { businessId: FLEET } });
    await prisma.apiKey.deleteMany({ where: { businessId: FLEET } });
  }

  it("refuses the company's administrator on all twelve routes with MODULE_NOT_ENABLED", async () => {
    const { endpointId, routes } = await everyRoute("");

    expect(routes).toHaveLength(12);

    for (const [method, url, payload] of routes) {
      const response = await call(FLEET_ADMIN, method, url, payload);

      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(
        403,
      );
      expect(response.json().code, `${method} ${url}`).toBe(
        "MODULE_NOT_ENABLED",
      );
    }

    await expectUntouched(endpointId);
    await cleanFleet();
  });

  it("refuses the MASTER naming that company too, reading and writing", async () => {
    const { endpointId, routes } = await everyRoute(`?businessId=${FLEET}`);

    for (const [method, url, payload] of routes) {
      const response = await call(MASTER, method, url, payload);

      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(
        403,
      );
      expect(response.json().code, `${method} ${url}`).toBe(
        "MODULE_NOT_ENABLED",
      );
      expect(response.json().message).toMatch(/Módulos Contratados/);
    }

    await expectUntouched(endpointId);
    await cleanFleet();
  });

  it("lets the MASTER through for a company that has the module", async () => {
    const response = await call(
      MASTER,
      "GET",
      `/integrations/api-keys?businessId=${CARRIER}`,
    );

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe("the endpoint cap (DLVB-24)", () => {
  it("lets exactly one of three simultaneous creates take the tenth place", async () => {
    for (
      let index = 0;
      index < MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS - 1;
      index += 1
    ) {
      await seedEndpoint(CARRIER, { is_active: index % 2 === 0 });
    }

    const answers = await Promise.all(
      [0, 1, 2].map(() =>
        call(
          ADMIN,
          "POST",
          `/integrations/webhook-endpoint/${CARRIER}`,
          endpointBody(),
        ),
      ),
    );

    const statuses = answers.map((answer) => answer.statusCode).sort();

    expect(statuses).toEqual([201, 409, 409]);

    for (const answer of answers.filter((entry) => entry.statusCode === 409)) {
      expect(answer.json().code).toBe("WEBHOOK_ENDPOINT_LIMIT_REACHED");
    }

    expect(
      await prisma.webhookEndpoint.count({ where: { businessId: CARRIER } }),
    ).toBe(MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS);
  });

  it("counts per company: another company still has room", async () => {
    const response = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${OTHER}`,
      endpointBody(),
    );

    expect(response.statusCode, response.body).toBe(201);
  });

  it("refuses a URL past 2,048 characters and an internal address at save", async () => {
    const long = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${OTHER}`,
      {
        ...endpointBody(),
        url: `https://erp.exemplo.com.br/${"a".repeat(2048)}`,
      },
    );

    expect(long.statusCode).toBe(400);

    const internal = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${OTHER}`,
      {
        ...endpointBody(),
        url: "https://169.254.169.254/latest/meta-data",
      },
    );

    expect(internal.statusCode).toBe(400);
    expect(internal.body).toMatch(/alcançável pela internet/);
  });
});

describe("all the events of the Documentos family (DLVB-22)", () => {
  it("is published in the catalogue as the three prefixes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/catalogue",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().families).toEqual([
      { family: "route", wildcards: ["route.*"] },
      {
        family: "document",
        wildcards: ["delivery.*", "occurrence.*", "proof.*"],
      },
    ]);
  });

  it("refuses document.*, which matches no topic", async () => {
    const response = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${OTHER}`,
      endpointBody(["document.*"]),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/document\.\*/);
  });

  it("delivers every document topic to the three family wildcards, and to a legacy document.*", async () => {
    const created = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${OTHER}`,
      endpointBody(FAMILY_WILDCARDS.document),
    );

    expect(created.statusCode, created.body).toBe(201);

    const family = created.json().data.id as string;

    // Saved by the previous release while a deploy rolled, after the
    // migration had rewritten the stored ones.
    const legacy = await seedEndpoint(OTHER, { topics: ["document.*"] });

    for (const topic of [
      "delivery.created",
      "occurrence.reported",
      "proof.registered",
    ] as const) {
      await fanOutWebhookEvent({
        topic,
        businessId: OTHER,
        payload: { id: randomUUID() },
      });
    }

    for (const endpointId of [family, legacy]) {
      const topics = await prisma.webhookDelivery.findMany({
        where: { endpointId },
        select: { topic: true },
      });

      expect(topics.map((entry) => entry.topic).sort(), endpointId).toEqual([
        "delivery.created",
        "occurrence.reported",
        "proof.registered",
      ]);
    }
  });
});

describe("reactivating an endpoint our breaker switched off (decision 2.5)", () => {
  it("is refused to whoever may not write integrations, or belongs elsewhere", async () => {
    const endpointId = await seedEndpoint(CARRIER, {
      disabled_at: new Date(),
      consecutive_failures: 20,
    });

    const path = `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/reactivate`;

    for (const userId of [READER, OUTSIDER, DRIVER_USER]) {
      const response = await call(userId, "POST", path);

      expect(response.statusCode, `${userId}: ${response.body}`).toBe(403);
    }

    // Another company's administrator naming this company...
    const crossTenant = await call(OTHER_ADMIN, "POST", path);

    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().code).toBe("TENANT_ACCESS_DENIED");

    // ...or naming their own company with this company's endpoint.
    const foreignId = await call(
      OTHER_ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${endpointId}/business/${OTHER}/reactivate`,
    );

    expect(foreignId.statusCode).toBe(404);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(row.disabled_at).not.toBeNull();
    expect(row.consecutive_failures).toBe(20);
  });

  it("turns it back on and sends what it held, without touching anything else", async () => {
    const endpointId = await seedEndpoint(CARRIER, {
      topics: ["route.*"],
      disabled_at: new Date(),
      consecutive_failures: 20,
    });

    const held = [
      await heldRow(CARRIER, endpointId),
      await heldRow(CARRIER, endpointId),
    ];

    const response = await call(
      ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/reactivate`,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      id: endpointId,
      reactivated: true,
      released: 2,
    });

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.disabled_at).toBeNull();
    expect(endpoint.consecutive_failures).toBe(0);
    expect(endpoint.topics).toEqual(["route.*"]);

    const rows = await prisma.webhookDelivery.findMany({
      where: { id: { in: held } },
    });

    // Due now instead of parked for the replay window. Compared loosely: a
    // dispatcher sweeping in another test file may already have taken one.
    for (const row of rows) {
      expect(row.availableAt.getTime()).toBeLessThan(
        Date.now() + 10 * 60 * 1000,
      );
      expect(row.lastError).not.toBe(ENDPOINT_PAUSED_REASON);
    }

    // A second click finds nothing to do and says so instead of failing.
    const again = await call(
      ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/reactivate`,
    );

    expect(again.statusCode).toBe(200);
    expect(again.json().data.reactivated).toBe(false);
    expect(again.json().message).toBe(
      "Este endpoint já estava recebendo eventos.",
    );
  });

  it("leaves a paused endpoint paused, holding its events", async () => {
    const endpointId = await seedEndpoint(CARRIER, {
      is_active: false,
      disabled_at: new Date(),
      consecutive_failures: 20,
    });

    const held = await heldRow(CARRIER, endpointId);

    const response = await call(
      ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/reactivate`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      reactivated: true,
      released: 0,
    });
    expect(response.json().message).toMatch(/continua pausado/);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.is_active).toBe(false);

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: held },
    });

    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    // A second click (or a stale screen) must not claim the endpoint is
    // receiving events: it is still paused.
    const again = await call(
      ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/reactivate`,
    );

    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({
      reactivated: false,
      released: 0,
    });
    expect(again.json().message).not.toMatch(/recebendo eventos\./);
    expect(again.json().message).toMatch(/pausado/);
  });

  it("answers 404 for an endpoint that does not exist", async () => {
    const response = await call(
      ADMIN,
      "POST",
      `/integrations/webhook-endpoint/${randomUUID()}/business/${CARRIER}/reactivate`,
    );

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("WEBHOOK_ENDPOINT_NOT_FOUND");
  });
});

describe("the monitor and the usage reads", () => {
  it("refuse another company's data", async () => {
    for (const url of [
      `/integrations/webhook-deliveries?page=1&pageSize=5&businessId=${OTHER}`,
      `/integrations/webhook-deliveries?page=1&pageSize=5&status=QUEUED&businessId=${OTHER}`,
      `/integrations/api-usage?days=1&businessId=${OTHER}`,
      `/integrations/webhook-endpoints?businessId=${OTHER}`,
    ]) {
      const response = await call(ADMIN, "GET", url);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("TENANT_ACCESS_DENIED");
    }
  });

  it("are open to a read-only profile and closed to a profile without integrations", async () => {
    const url =
      "/integrations/webhook-deliveries?page=1&pageSize=5&status=QUEUED";

    expect((await call(READER, "GET", url)).statusCode).toBe(200);
    expect((await call(OUTSIDER, "GET", url)).statusCode).toBe(403);
    expect(
      (await call(DRIVER_USER, "GET", "/integrations/api-usage?days=1"))
        .statusCode,
    ).toBe(403);
  });

  it("count today's usage in the company's own calendar (DLVB-33)", async () => {
    const key = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        name: "ERP de Manaus",
        prefix: key.prefix,
        token_hash: key.tokenHash,
        scopes: ["deliveries:read"],
        businessId: CARRIER,
      },
    });

    const today = businessToday("America/Manaus");
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    await prisma.apiKeyUsageDaily.createMany({
      data: [
        { day: today, count: 5n },
        { day: yesterday, count: 7n },
      ].map((bucket) => ({
        apiKeyId: apiKey.id,
        businessId: CARRIER,
        day: bucket.day,
        method: "GET",
        route: "/integration/v1/deliveries",
        status_class: 2,
        count: bucket.count,
      })),
    });

    const hoje = await call(ADMIN, "GET", "/integrations/api-usage?days=1");

    expect(hoje.statusCode, hoje.body).toBe(200);

    const data = hoje.json().data;

    expect(data.timeZone).toBe("America/Manaus");
    expect(data.totals.ok).toBe(5);
    expect(data.byDay).toEqual([{ day: dateOnlyKey(today), total: 5 }]);

    const twoDays = (
      await call(ADMIN, "GET", "/integrations/api-usage?days=2")
    ).json().data;

    expect(twoDays.byDay).toEqual([
      { day: dateOnlyKey(yesterday), total: 7 },
      { day: dateOnlyKey(today), total: 5 },
    ]);
  });
});
