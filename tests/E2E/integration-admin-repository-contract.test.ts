import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { WebhookDeliveryStatus, type WebhookDelivery } from "@prisma/client";

import { ApiKeyRepository } from "@/modules/integration/repositories/api-key-repository";
import { WebhookEndpointRepository } from "@/modules/integration/repositories/webhook-endpoint-repository";
import { WebhookDeliveryRepository } from "@/modules/integration/repositories/webhook-delivery-repository";
import { InMemoryApiKeyRepository } from "@/modules/integration/repositories/in-memory/in-memory-api-key-repository";
import { InMemoryWebhookEndpointRepository } from "@/modules/integration/repositories/in-memory/in-memory-webhook-endpoint-repository";
import { InMemoryWebhookDeliveryRepository } from "@/modules/integration/repositories/in-memory/in-memory-webhook-delivery-repository";
import type { IApiKeyRepository } from "@/modules/integration/repositories/IApi-key-repository";
import type { IWebhookEndpointRepository } from "@/modules/integration/repositories/IWebhook-endpoint-repository";
import type { IWebhookDeliveryRepository } from "@/modules/integration/repositories/IWebhook-delivery-repository";

import { ENDPOINT_PAUSED_REASON } from "@/shared/integration/webhook-dispatch-rules";

import { expectPrismaCode } from "../contract/support";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The integration screens' repositories against Postgres and against their
 * in-memory twins (TEST-ARCH-1): ONE suite, the same fixtures in both, so a
 * unit test that passes on a twin would pass on the database — quotas,
 * company scoping, the breaker, the monitor's window, order, cap and p95.
 */
const prisma = createPrismaClient();

interface Harness {
  apiKeys: IApiKeyRepository;
  endpoints: IWebhookEndpointRepository;
  deliveries: IWebhookDeliveryRepository;
  seedDelivery: (
    row: Partial<WebhookDelivery> & {
      endpointId: string;
      businessId: string;
      created_at: Date;
    },
  ) => Promise<string>;
  seedUsage: (row: {
    apiKeyId: string;
    businessId: string;
    day: Date;
    route: string;
    count: bigint;
  }) => Promise<void>;
  switchOff: (endpointId: string) => Promise<void>;
  endpoint: (id: string) => Promise<{
    disabled_at: Date | null;
    consecutive_failures: number;
    headers: unknown;
    secret: string;
    previous_secret: string | null;
  } | null>;
  delivery: (id: string) => Promise<WebhookDelivery | null>;
  deactivate: (businessId: string) => Promise<void>;
  lastUsedAt: (apiKeyId: string) => Promise<Date | null>;
}

const created: string[] = [];

async function seedBusiness(): Promise<string> {
  const id = randomUUID();

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(
        Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999),
      ),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      timezone: "America/Manaus",
    },
  });

  created.push(id);

  return id;
}

function deliveryRow(
  row: Partial<WebhookDelivery> & {
    endpointId: string;
    businessId: string;
    created_at: Date;
  },
): WebhookDelivery {
  return {
    id: randomUUID(),
    topic: "delivery.created",
    sourceEventId: randomUUID(),
    payload: { id: "delivery-1" },
    signature: "sig",
    signed_body: "{}",
    status: WebhookDeliveryStatus.PENDING,
    attempts: 0,
    availableAt: row.created_at,
    leaseExpiresAt: null,
    response_status: null,
    response_body: null,
    latency_ms: null,
    deliveredAt: null,
    lastError: null,
    resent_from_id: null,
    updated_at: row.created_at,
    ...row,
  };
}

function prismaHarness(): Harness {
  return {
    apiKeys: new ApiKeyRepository(prisma),
    endpoints: new WebhookEndpointRepository(prisma),
    deliveries: new WebhookDeliveryRepository(prisma),
    async seedDelivery(row) {
      const data = deliveryRow(row);

      await prisma.webhookDelivery.create({
        data: { ...data, payload: data.payload as object },
      });

      return data.id;
    },
    async seedUsage(row) {
      await prisma.apiKeyUsageDaily.create({
        data: { ...row, method: "GET", status_class: 2 },
      });
    },
    async switchOff(endpointId) {
      await prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { disabled_at: new Date(), consecutive_failures: 9 },
      });
    },
    endpoint: (id) => prisma.webhookEndpoint.findUnique({ where: { id } }),
    delivery: (id) => prisma.webhookDelivery.findUnique({ where: { id } }),
    async deactivate(businessId) {
      await prisma.business.update({
        where: { id: businessId },
        data: { is_active: false },
      });
    },
    async lastUsedAt(apiKeyId) {
      return (
        (await prisma.apiKey.findUnique({ where: { id: apiKeyId } }))
          ?.last_used_at ?? null
      );
    },
  };
}

function memoryHarness(timeZones: Map<string, string>): Harness {
  const apiKeys = new InMemoryApiKeyRepository([], [], timeZones);
  const endpoints = new InMemoryWebhookEndpointRepository();
  const deliveries = new InMemoryWebhookDeliveryRepository(endpoints);

  return {
    apiKeys,
    endpoints,
    deliveries,
    async seedDelivery(row) {
      const data = deliveryRow(row);

      deliveries.deliveries.push(data);

      return data.id;
    },
    async seedUsage(row) {
      apiKeys.usage.push({ ...row, method: "GET", status_class: 2 });
    },
    async switchOff(endpointId) {
      const endpoint = endpoints.endpoints.find(
        (candidate) => candidate.id === endpointId,
      )!;

      endpoint.disabled_at = new Date();
      endpoint.consecutive_failures = 9;
    },
    async endpoint(id) {
      return (
        endpoints.endpoints.find((candidate) => candidate.id === id) ?? null
      );
    },
    async delivery(id) {
      return (
        deliveries.deliveries.find((candidate) => candidate.id === id) ?? null
      );
    },
    async deactivate(businessId) {
      apiKeys.inactiveBusinesses.add(businessId);
    },
    async lastUsedAt(apiKeyId) {
      return (
        apiKeys.keys.find((candidate) => candidate.id === apiKeyId)
          ?.last_used_at ?? null
      );
    },
  };
}

const companies = { a: "", b: "" };

beforeAll(async () => {
  companies.a = await seedBusiness();
  companies.b = await seedBusiness();
}, 60_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

const key = (businessId: string, name = "ERP") => ({
  name,
  prefix: `trj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  token_hash: randomUUID(),
  scopes: ["deliveries:read"],
  rate_limit_per_minute: 120,
  businessId,
});

const endpoint = (name = "ERP", is_active = true) => ({
  name,
  url: "https://erp.exemplo.com.br/hook",
  secret: "sealed-secret",
  topics: ["delivery.*"],
  headers: { Authorization: "sealed" },
  is_active,
});

describe.each([
  ["Postgres", () => prismaHarness()],
  [
    "in-memory twin",
    () =>
      memoryHarness(
        new Map([
          [companies.a, "America/Manaus"],
          [companies.b, "America/Manaus"],
        ]),
      ),
  ],
] as const)("integration admin repositories — %s", (_label, build) => {
  // Each harness gets its own two companies' worth of rows: the Postgres one
  // writes under fresh ids, the twin starts empty.
  let h: Harness;
  let A: string;
  let B: string;

  beforeAll(async () => {
    h = build();
    A = companies.a;
    B = companies.b;

    if (_label === "Postgres") {
      // Isolated from the twin's assertions: new companies for this harness.
      A = await seedBusiness();
      B = await seedBusiness();
    }
  }, 60_000);

  it("API keys: the quota counts only active keys of the company; revoke is scoped and one-shot", async () => {
    const first = await h.apiKeys.createWithinQuota(key(A, "Um"), 2);
    await h.apiKeys.createWithinQuota(key(A, "Dois"), 2);

    expect(await h.apiKeys.createWithinQuota(key(A, "Três"), 2)).toBeNull();
    // Another company's quota is its own.
    expect(
      await h.apiKeys.createWithinQuota(key(B, "Alheia"), 2),
    ).not.toBeNull();

    expect(await h.apiKeys.revoke(first!.id, B, new Date())).toBe(false);
    expect(await h.apiKeys.revoke(first!.id, A, new Date())).toBe(true);
    expect(await h.apiKeys.revoke(first!.id, A, new Date())).toBe(false);

    expect(await h.apiKeys.createWithinQuota(key(A, "Três"), 2)).not.toBeNull();

    const listed = await h.apiKeys.listByBusiness(A);

    expect(listed.map((row) => row.name).sort()).toEqual([
      "Dois",
      "Três",
      "Um",
    ]);
    expect(listed.find((row) => row.name === "Um")?.revoked_at).not.toBeNull();
    expect(Object.keys(listed[0]).sort()).toEqual([
      "created_at",
      "id",
      "last_used_at",
      "name",
      "prefix",
      "rate_limit_per_minute",
      "revoked_at",
      "scopes",
    ]);
  });

  it("API usage: scoped by company, from `since`, filtered by key, day desc then route asc", async () => {
    const issued = await h.apiKeys.createWithinQuota(key(B, "Uso"), 50);
    const other = await h.apiKeys.createWithinQuota(key(B, "Outra"), 50);
    const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

    await h.seedUsage({
      apiKeyId: issued!.id,
      businessId: B,
      day: day("2026-10-04"),
      route: "/b",
      count: 2n,
    });
    await h.seedUsage({
      apiKeyId: issued!.id,
      businessId: B,
      day: day("2026-10-05"),
      route: "/b",
      count: 3n,
    });
    await h.seedUsage({
      apiKeyId: issued!.id,
      businessId: B,
      day: day("2026-10-05"),
      route: "/a",
      count: 4n,
    });
    await h.seedUsage({
      apiKeyId: other!.id,
      businessId: B,
      day: day("2026-10-05"),
      route: "/c",
      count: 5n,
    });
    await h.seedUsage({
      apiKeyId: issued!.id,
      businessId: B,
      day: day("2026-09-01"),
      route: "/old",
      count: 9n,
    });

    const rows = await h.apiKeys.listUsage({
      businessId: B,
      since: day("2026-10-04"),
      apiKeyId: issued!.id,
    });

    expect(rows.map((row) => [row.route, Number(row.count)])).toEqual([
      ["/a", 4],
      ["/b", 3],
      ["/b", 2],
    ]);
    expect(rows[0].apiKey?.name).toBe("Uso");
    expect(
      await h.apiKeys.listUsage({ businessId: A, since: day("2026-01-01") }),
    ).toEqual([]);
    expect(await h.apiKeys.businessTimeZone(B)).toBe("America/Manaus");
  });

  it("endpoints: quota with paused ones, scoped edit that clears the breaker, headers kept or cleared", async () => {
    const first = await h.endpoints.createWithinQuota(
      A,
      endpoint("Um", false),
      2,
    );
    await h.endpoints.createWithinQuota(A, endpoint("Dois"), 2);

    expect(
      await h.endpoints.createWithinQuota(A, endpoint("Três"), 2),
    ).toBeNull();

    await h.switchOff(first!.id);

    const edit = {
      name: "Um editado",
      url: "https://erp.exemplo.com.br/novo",
      topics: ["route.*"],
      is_active: true,
    };

    expect(await h.endpoints.update(first!.id, B, edit)).toBe(false);
    expect(await h.endpoints.update(first!.id, A, edit)).toBe(true);

    let stored = await h.endpoint(first!.id);

    expect(stored).toMatchObject({
      disabled_at: null,
      consecutive_failures: 0,
    });
    expect(stored?.headers).toEqual({ Authorization: "sealed" });

    await h.endpoints.update(first!.id, A, { ...edit, headers: null });

    stored = await h.endpoint(first!.id);

    expect(stored?.headers).toBeNull();
    expect(await h.endpoints.find(first!.id, B)).toBeNull();
    expect(await h.endpoints.find(first!.id, A)).toEqual({
      id: first!.id,
      name: "Um editado",
      is_active: true,
    });
  });

  it("endpoints: the breaker resets only when off; rotation keeps the replaced secret; delete is scoped and cascades", async () => {
    const one = await h.endpoints.createWithinQuota(B, endpoint("Breaker"), 50);

    expect(await h.endpoints.resetBreaker(one!.id, B)).toBe(false);

    await h.switchOff(one!.id);

    expect(await h.endpoints.resetBreaker(one!.id, A)).toBe(false);
    expect(await h.endpoints.resetBreaker(one!.id, B)).toBe(true);

    const rotation = {
      secret: "novo",
      previousOf: (current: string) => `kept:${current}`,
      previousExpiresAt: new Date(Date.now() + 86_400_000),
    };

    expect(await h.endpoints.rotateSecret(one!.id, A, rotation)).toBe(false);
    expect(await h.endpoints.rotateSecret(one!.id, B, rotation)).toBe(true);
    expect(await h.endpoint(one!.id)).toMatchObject({
      secret: "novo",
      previous_secret: "kept:sealed-secret",
    });

    const row = await h.seedDelivery({
      endpointId: one!.id,
      businessId: B,
      created_at: new Date(),
    });

    expect(await h.endpoints.delete(one!.id, A)).toBe(false);
    expect(await h.endpoints.delete(one!.id, B)).toBe(true);
    expect(await h.deliveries.findForResend(row, B)).toBeNull();
  });

  it("monitor: queue of any age, settled rows inside the window, order, cap and nearest-rank p95", async () => {
    const hook = await h.endpoints.createWithinQuota(
      A,
      endpoint("Monitor"),
      50,
    );
    const now = Date.now();
    const ago = (hours: number) => new Date(now - hours * 3_600_000);
    const id = hook!.id;

    const queued = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(72),
    });
    const d1 = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(1),
      status: "DELIVERED",
      latency_ms: 100,
    });
    const d2 = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(2),
      status: "DELIVERED",
      latency_ms: 300,
    });
    await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(30),
      status: "DELIVERED",
      latency_ms: 900,
    });
    const failed = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(3),
      status: "FAILED",
    });
    const processing = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: ago(4),
      status: "PROCESSING",
    });

    const query = {
      businessId: A,
      endpointId: id,
      since: ago(24),
      page: 1,
      pageSize: 10,
      cap: 100,
    };

    const all = await h.deliveries.monitor(query);

    expect(all.rows.map((row) => row.id)).toEqual([
      d1,
      d2,
      failed,
      processing,
      queued,
    ]);
    expect(all).toMatchObject({
      counted: 5,
      delivered: 2,
      failed: 1,
      queued: 2,
      p95LatencyMs: 300,
    });
    expect(all.rows[0].endpoint).toEqual({
      id,
      name: "Monitor",
      url: "https://erp.exemplo.com.br/hook",
    });

    const queue = await h.deliveries.monitor({ ...query, status: "QUEUED" });

    expect(queue.rows.map((row) => row.id)).toEqual([processing, queued]);

    const capped = await h.deliveries.monitor({
      ...query,
      pageSize: 2,
      cap: 3,
    });

    expect(capped.counted).toBe(4);
    expect(capped.rows).toHaveLength(2);

    // Another company sees none of it.
    const foreign = await h.deliveries.monitor({ ...query, businessId: B });

    expect(foreign).toMatchObject({
      counted: 0,
      delivered: 0,
      failed: 0,
      queued: 0,
      p95LatencyMs: null,
    });
  });

  it("resend and release: a new row with the same bytes, parked while off, released when back", async () => {
    const hook = await h.endpoints.createWithinQuota(
      A,
      endpoint("Reenvio", false),
      50,
    );
    const id = hook!.id;
    const original = await h.seedDelivery({
      endpointId: id,
      businessId: A,
      created_at: new Date(Date.now() - 3_600_000),
      status: "FAILED",
      lastError: "HTTP 500",
    });

    expect(await h.deliveries.findForResend(original, B)).toBeNull();

    const found = await h.deliveries.findForResend(original, A);

    expect(found?.endpoint).toEqual({ is_active: false, disabled_at: null });

    const parked = new Date(Date.now() + 30 * 86_400_000);
    const resent = await h.deliveries.createResend(found!, {
      availableAt: parked,
      lastError: ENDPOINT_PAUSED_REASON,
    });

    let row = await h.delivery(resent.id);

    expect(row).toMatchObject({
      resent_from_id: original,
      sourceEventId: found!.sourceEventId,
      signature: "sig",
      status: "PENDING",
      lastError: ENDPOINT_PAUSED_REASON,
    });

    // Still paused: nothing to release for that row.
    await h.deliveries.releaseHeldIfEndpointBack(resent.id, id);
    expect((await h.delivery(resent.id))?.lastError).toBe(
      ENDPOINT_PAUSED_REASON,
    );

    await h.endpoints.update(id, A, {
      name: "Reenvio",
      url: "https://erp.exemplo.com.br/hook",
      topics: ["delivery.*"],
      is_active: true,
    });

    expect(await h.deliveries.releaseParked(id)).toBe(1);

    row = await h.delivery(resent.id);

    expect(row?.lastError).toBeNull();
    expect(row!.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // Last on purpose: it switches company B off.
  it("authentication lookup: by prefix, revoked included, with the company's gates; last use is recorded", async () => {
    const issued = await h.apiKeys.createWithinQuota(
      key(B, "Autenticação"),
      50,
    );
    const credential = await h.apiKeys.findCredentialByPrefix(issued!.prefix);

    expect(credential).toMatchObject({
      id: issued!.id,
      name: "Autenticação",
      prefix: issued!.prefix,
      scopes: ["deliveries:read"],
      rate_limit_per_minute: 120,
      revoked_at: null,
      businessId: B,
      business: { is_active: true, timezone: "America/Manaus" },
    });
    expect(typeof credential!.token_hash).toBe("string");
    expect(
      await h.apiKeys.findCredentialByPrefix("trj_naoexiste000000"),
    ).toBeNull();

    // Revoked keys still come back: the middleware answers them with the
    // same 401 as an unknown one, and needs the row to know.
    await h.apiKeys.revoke(issued!.id, B, new Date());
    expect(
      (await h.apiKeys.findCredentialByPrefix(issued!.prefix))!.revoked_at,
    ).not.toBeNull();

    const at = new Date("2026-10-06T12:00:00.000Z");

    await h.apiKeys.touchLastUsed(issued!.id, at);
    expect((await h.lastUsedAt(issued!.id))?.toISOString()).toBe(
      at.toISOString(),
    );
    await expectPrismaCode(h.apiKeys.touchLastUsed(randomUUID(), at), "P2025");

    await h.deactivate(B);
    expect(
      (await h.apiKeys.findCredentialByPrefix(issued!.prefix))!.business
        .is_active,
    ).toBe(false);
  });
});
