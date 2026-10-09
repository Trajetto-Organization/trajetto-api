import "reflect-metadata";

import { beforeEach, describe, expect, it } from "vitest";

import { WebhookDeliveryStatus, type User, type WebhookDelivery } from "@prisma/client";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryApiKeyRepository } from "@/modules/integration/repositories/in-memory/in-memory-api-key-repository";
import { InMemoryWebhookEndpointRepository } from "@/modules/integration/repositories/in-memory/in-memory-webhook-endpoint-repository";
import { InMemoryWebhookDeliveryRepository } from "@/modules/integration/repositories/in-memory/in-memory-webhook-delivery-repository";

import {
  CreateApiKeyUseCase,
  ListApiKeysUseCase,
  RevokeApiKeyUseCase,
} from "@/modules/integration/usecases/integration-admin/api-key-usecases";
import {
  DeleteWebhookEndpointUseCase,
  ListWebhookEndpointsUseCase,
  ReactivateWebhookEndpointUseCase,
  RotateWebhookSecretUseCase,
  SaveWebhookEndpointUseCase,
} from "@/modules/integration/usecases/integration-admin/webhook-endpoint-usecases";
import {
  ListApiUsageUseCase,
  ListWebhookDeliveriesUseCase,
  ResendWebhookDeliveryUseCase,
} from "@/modules/integration/usecases/integration-admin/webhook-monitor-usecases";
import type { ActivityRecorder } from "@/modules/integration/usecases/integration-admin/integration-admin-access";

import { MAX_ACTIVE_API_KEYS_PER_BUSINESS } from "@/shared/integration/api-key-rules";
import {
  ENDPOINT_PAUSED_REASON,
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
} from "@/shared/integration/webhook-dispatch-rules";

/**
 * The integration screens' rules without a database (TEST-ARCH-1): they
 * lived in an 868-line controller that called Prisma directly, so none of
 * them could be tested apart from an HTTP round trip.
 */
const CARRIER = "carrier";
const OTHER = "other";

const ADMIN = "admin";
const OTHER_ADMIN = "other-admin";
const MASTER = "master";

let users: InMemoryUserRepository;
let apiKeys: InMemoryApiKeyRepository;
let endpoints: InMemoryWebhookEndpointRepository;
let deliveries: InMemoryWebhookDeliveryRepository;
let trail: Array<{ action: string; entityId: string; businessId: string | null; description: string }>;

const recorder: ActivityRecorder = {
  async createActivityIfEnabled(activity) {
    trail.push(activity);
  },
};

beforeEach(() => {
  users = new InMemoryUserRepository();
  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );

  apiKeys = new InMemoryApiKeyRepository();
  endpoints = new InMemoryWebhookEndpointRepository();
  deliveries = new InMemoryWebhookDeliveryRepository(endpoints);
  trail = [];
});

const keyRequest = (overrides: Partial<{ userId: string; businessId: string; rate: number }> = {}) => ({
  userId: overrides.userId ?? ADMIN,
  businessId: overrides.businessId ?? CARRIER,
  name: "ERP",
  scopes: ["deliveries:read"],
  rate_limit_per_minute: overrides.rate ?? 120,
});

describe("API keys", () => {
  it("issues a key once, returns the token only here and records the prefix, never the token", async () => {
    const created = await new CreateApiKeyUseCase(apiKeys, users, recorder).execute(keyRequest());

    expect(created.token.startsWith(`${created.prefix}.`)).toBe(true);
    expect(apiKeys.keys[0].token_hash).not.toContain(created.token.split(".")[1]);
    expect(trail).toHaveLength(1);
    expect(trail[0].description).toContain(created.prefix);
    expect(trail[0].description).not.toContain(created.token);

    const listed = await new ListApiKeysUseCase(apiKeys, users).execute(ADMIN, CARRIER);

    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("token_hash");
  });

  it("refuses a tenant rate above the plan with 403 API_KEY_RATE_ABOVE_PLAN, but lets the MASTER", async () => {
    const create = new CreateApiKeyUseCase(apiKeys, users, recorder);

    await expect(create.execute(keyRequest({ rate: 6000 }))).rejects.toMatchObject({
      statusCode: 403,
      code: "API_KEY_RATE_ABOVE_PLAN",
    });
    expect(apiKeys.keys).toHaveLength(0);

    await expect(
      create.execute(keyRequest({ userId: MASTER, rate: 6000 })),
    ).resolves.toMatchObject({ prefix: expect.any(String) });
  });

  it("stops at the active-key limit with 409, and a revoked key frees its place", async () => {
    const create = new CreateApiKeyUseCase(apiKeys, users, recorder);

    for (let index = 0; index < MAX_ACTIVE_API_KEYS_PER_BUSINESS; index++) {
      await create.execute(keyRequest());
    }

    await expect(create.execute(keyRequest())).rejects.toMatchObject({
      statusCode: 409,
      code: "API_KEY_LIMIT_REACHED",
    });

    // Another company's quota is its own.
    await expect(
      create.execute(keyRequest({ userId: OTHER_ADMIN, businessId: OTHER })),
    ).resolves.toBeTruthy();

    await new RevokeApiKeyUseCase(apiKeys, users, recorder).execute(
      ADMIN,
      CARRIER,
      apiKeys.keys[0].id,
    );

    await expect(create.execute(keyRequest())).resolves.toBeTruthy();
  });

  it("answers another company's key, a made-up id and a second revoke alike: 404 API_KEY_NOT_FOUND", async () => {
    const foreign = await new CreateApiKeyUseCase(apiKeys, users, recorder).execute(
      keyRequest({ userId: OTHER_ADMIN, businessId: OTHER }),
    );
    const revoke = new RevokeApiKeyUseCase(apiKeys, users, recorder);

    await expect(revoke.execute(ADMIN, CARRIER, foreign.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "API_KEY_NOT_FOUND",
    });
    expect(apiKeys.keys.find((key) => key.id === foreign.id)?.revoked_at).toBeNull();

    await revoke.execute(OTHER_ADMIN, OTHER, foreign.id);

    await expect(revoke.execute(OTHER_ADMIN, OTHER, foreign.id)).rejects.toMatchObject({
      code: "API_KEY_NOT_FOUND",
    });
  });

  it("refuses an administrator acting on another company with 403 TENANT_ACCESS_DENIED", async () => {
    await expect(
      new ListApiKeysUseCase(apiKeys, users).execute(ADMIN, OTHER),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    await expect(
      new CreateApiKeyUseCase(apiKeys, users, recorder).execute(
        keyRequest({ businessId: OTHER }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(apiKeys.keys).toHaveLength(0);
  });

  it("answers a session whose user is gone with 404 USER_NOT_FOUND", async () => {
    await expect(
      new ListApiKeysUseCase(apiKeys, users).execute("ghost", CARRIER),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

const endpointRequest = (overrides: Partial<Parameters<SaveWebhookEndpointUseCase["execute"]>[0]> = {}) => ({
  userId: ADMIN,
  businessId: CARRIER,
  name: "ERP",
  url: "https://erp.exemplo.com.br/webhooks",
  topics: ["delivery.*"],
  is_active: true,
  ...overrides,
});

function save() {
  return new SaveWebhookEndpointUseCase(endpoints, deliveries, users, recorder);
}

function heldRow(endpointId: string, createdAt: Date): WebhookDelivery {
  return {
    id: `row-${deliveries.deliveries.length + 1}`,
    endpointId,
    businessId: CARRIER,
    topic: "delivery.created",
    sourceEventId: "event-1",
    payload: { id: "delivery-1" },
    signature: "sig",
    signed_body: "{}",
    status: WebhookDeliveryStatus.PENDING,
    attempts: 0,
    availableAt: new Date(Date.now() + 86_400_000),
    leaseExpiresAt: null,
    response_status: null,
    response_body: null,
    latency_ms: null,
    deliveredAt: null,
    lastError: ENDPOINT_PAUSED_REASON,
    resent_from_id: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("webhook endpoints", () => {
  it("creates with a secret shown once, and an edit keeps the headers when they are omitted", async () => {
    const created = await save().execute(
      endpointRequest({ headers: { Authorization: "Bearer x" } }),
    );

    expect(created).toMatchObject({ created: true, secret: expect.any(String) });

    const stored = endpoints.endpoints[0];
    const headersBefore = stored.headers;

    const edited = await save().execute(endpointRequest({ id: created.id, name: "ERP 2" }));

    expect(edited).toEqual({ id: created.id, secret: null, created: false });
    expect(stored.name).toBe("ERP 2");
    expect(stored.headers).toEqual(headersBefore);

    await save().execute(endpointRequest({ id: created.id, headers: null }));

    expect(stored.headers).toBeNull();
  });

  it("an edit clears our breaker and releases what the endpoint held", async () => {
    const { id } = await save().execute(endpointRequest());
    const stored = endpoints.endpoints[0];

    stored.disabled_at = new Date();
    stored.consecutive_failures = 9;
    deliveries.deliveries.push(heldRow(id, new Date()));

    await save().execute(endpointRequest({ id }));

    expect(stored.disabled_at).toBeNull();
    expect(stored.consecutive_failures).toBe(0);
    expect(deliveries.deliveries[0].lastError).toBeNull();
    expect(deliveries.deliveries[0].availableAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("stops at the endpoint limit with 409, paused endpoints included", async () => {
    for (let index = 0; index < MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS; index++) {
      await save().execute(endpointRequest({ is_active: index % 2 === 0 }));
    }

    await expect(save().execute(endpointRequest())).rejects.toMatchObject({
      statusCode: 409,
      code: "WEBHOOK_ENDPOINT_LIMIT_REACHED",
    });
  });

  it("answers another company's endpoint like a missing one on edit, rotate, reactivate and delete", async () => {
    const foreign = await save().execute(
      endpointRequest({ userId: OTHER_ADMIN, businessId: OTHER }),
    );
    const notFound = { statusCode: 404, code: "WEBHOOK_ENDPOINT_NOT_FOUND" };

    await expect(save().execute(endpointRequest({ id: foreign.id }))).rejects.toMatchObject(notFound);
    await expect(
      new RotateWebhookSecretUseCase(endpoints, users, recorder).execute(ADMIN, CARRIER, foreign.id),
    ).rejects.toMatchObject(notFound);
    await expect(
      new ReactivateWebhookEndpointUseCase(endpoints, deliveries, users, recorder).execute(
        ADMIN,
        CARRIER,
        foreign.id,
      ),
    ).rejects.toMatchObject(notFound);
    await expect(
      new DeleteWebhookEndpointUseCase(endpoints, users, recorder).execute(ADMIN, CARRIER, foreign.id),
    ).rejects.toMatchObject(notFound);

    expect(endpoints.endpoints).toHaveLength(1);
    expect(endpoints.endpoints[0].name).toBe("ERP");
    expect(trail.filter((entry) => entry.businessId === CARRIER)).toHaveLength(0);
  });

  it("rotates the secret keeping the replaced one as previous, and a second rotation drops the oldest", async () => {
    const created = await save().execute(endpointRequest());
    const rotate = new RotateWebhookSecretUseCase(endpoints, users, recorder);
    const stored = endpoints.endpoints[0];
    const original = stored.secret;

    const first = await rotate.execute(ADMIN, CARRIER, created.id);

    expect(first).not.toBe(created.secret);
    expect(stored.previous_secret).toBe(original);
    expect(stored.previous_secret_expires_at!.getTime()).toBeGreaterThan(Date.now());

    const afterFirst = stored.secret;

    await rotate.execute(ADMIN, CARRIER, created.id);

    expect(stored.previous_secret).toBe(afterFirst);
  });

  it("reactivates only a switched-off endpoint, and leaves a paused one paused", async () => {
    const { id } = await save().execute(endpointRequest({ is_active: false }));
    const reactivate = new ReactivateWebhookEndpointUseCase(endpoints, deliveries, users, recorder);

    const idle = await reactivate.execute(ADMIN, CARRIER, id);

    expect(idle.data).toEqual({ id, reactivated: false, released: 0 });

    endpoints.endpoints[0].disabled_at = new Date();
    deliveries.deliveries.push(heldRow(id, new Date()));

    const paused = await reactivate.execute(ADMIN, CARRIER, id);

    // Breaker cleared, nothing released: the customer's own switch is off.
    expect(paused.data).toEqual({ id, reactivated: true, released: 0 });
    expect(endpoints.endpoints[0].is_active).toBe(false);
    expect(deliveries.deliveries[0].lastError).toBe(ENDPOINT_PAUSED_REASON);
  });

  it("lists only the company's endpoints, newest first, and deletes taking the deliveries with them", async () => {
    const first = await save().execute(endpointRequest({ name: "Primeiro" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await save().execute(endpointRequest({ name: "Segundo" }));
    await save().execute(endpointRequest({ userId: OTHER_ADMIN, businessId: OTHER, name: "Alheio" }));

    const listed = await new ListWebhookEndpointsUseCase(endpoints, users).execute(ADMIN, CARRIER);

    expect(listed.map((endpoint) => endpoint.name)).toEqual(["Segundo", "Primeiro"]);
    expect(listed[0]).not.toHaveProperty("secret");

    deliveries.deliveries.push(heldRow(first.id, new Date()));

    await new DeleteWebhookEndpointUseCase(endpoints, users, recorder).execute(ADMIN, CARRIER, first.id);

    expect(await deliveries.findForResend("row-1", CARRIER)).toBeNull();
  });
});

describe("monitor and resend", () => {
  it("resends as a NEW row with the same bytes, held while the endpoint is off", async () => {
    const { id } = await save().execute(endpointRequest({ is_active: false }));
    const original = heldRow(id, new Date());

    original.status = WebhookDeliveryStatus.FAILED;
    original.lastError = "HTTP 500";
    deliveries.deliveries.push(original);

    const resent = await new ResendWebhookDeliveryUseCase(deliveries, users).execute(
      ADMIN,
      CARRIER,
      original.id,
    );

    expect(resent.held).toBe(true);

    const row = deliveries.deliveries.find((delivery) => delivery.id === resent.id)!;

    expect(row).toMatchObject({
      resent_from_id: original.id,
      sourceEventId: original.sourceEventId,
      signature: original.signature,
      signed_body: original.signed_body,
      status: WebhookDeliveryStatus.PENDING,
      lastError: ENDPOINT_PAUSED_REASON,
    });
    expect(original.status).toBe(WebhookDeliveryStatus.FAILED);
  });

  it("refuses an event past the replay window with 409 OUTSIDE_REPLAY_WINDOW, and another company's with 404", async () => {
    const { id } = await save().execute(endpointRequest());
    const old = heldRow(id, new Date(Date.now() - 40 * 86_400_000));

    deliveries.deliveries.push(old);

    const resend = new ResendWebhookDeliveryUseCase(deliveries, users);

    await expect(resend.execute(ADMIN, CARRIER, old.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "OUTSIDE_REPLAY_WINDOW",
    });

    users.user.push({ id: "other-reader", role: "BUSINESS_ADMIN", businessId: OTHER } as User);

    await expect(resend.execute("other-reader", OTHER, old.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "WEBHOOK_DELIVERY_NOT_FOUND",
    });
  });

  it("counts the queue whatever its age, the settled rows inside the window, and pages within the cap", async () => {
    const { id } = await save().execute(endpointRequest());
    const now = new Date();
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

    const delivered = (hours: number, latency: number) => ({
      ...heldRow(id, hoursAgo(hours)),
      status: WebhookDeliveryStatus.DELIVERED,
      latency_ms: latency,
      lastError: null,
    });

    deliveries.deliveries.push(
      { ...heldRow(id, hoursAgo(72)) },
      delivered(1, 100),
      delivered(2, 300),
      delivered(30, 900),
      { ...heldRow(id, hoursAgo(3)), status: WebhookDeliveryStatus.FAILED, lastError: "HTTP 500" },
    );
    deliveries.deliveries.forEach((row, index) => (row.id = `row-${index + 1}`));

    const page = await new ListWebhookDeliveriesUseCase(deliveries, users).execute(
      { userId: ADMIN, businessId: CARRIER, page: 1, pageSize: 20 },
      now,
    );

    expect(page.meta).toMatchObject({
      window: "24h",
      delivered: 2,
      failed: 1,
      pending: 1,
      p95LatencyMs: 300,
      totalCapped: false,
    });
    // The 30-hour-old delivery is outside the window; the 72-hour-old queue row is not.
    expect(page.total).toBe(4);
    expect(page.data.map((row) => row.id)).toEqual(["row-2", "row-3", "row-5", "row-1"]);

    await expect(
      new ListWebhookDeliveriesUseCase(deliveries, users).execute(
        { userId: ADMIN, businessId: CARRIER, page: 501, pageSize: 20 },
        now,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "MONITOR_PAGE_OUT_OF_RANGE" });
  });

  it("reports API usage in the company's days, with the empty days and the keys", async () => {
    const created = await new CreateApiKeyUseCase(apiKeys, users, recorder).execute(keyRequest());

    apiKeys.timeZones.set(CARRIER, "America/Sao_Paulo");
    apiKeys.usage.push(
      {
        apiKeyId: created.id,
        businessId: CARRIER,
        day: new Date("2026-10-05T00:00:00.000Z"),
        method: "GET",
        route: "/integration/v1/deliveries",
        status_class: 2,
        count: 40n,
      },
      {
        apiKeyId: created.id,
        businessId: CARRIER,
        day: new Date("2026-10-03T00:00:00.000Z"),
        method: "POST",
        route: "/integration/v1/deliveries",
        status_class: 4,
        count: 3n,
      },
      {
        apiKeyId: created.id,
        businessId: OTHER,
        day: new Date("2026-10-05T00:00:00.000Z"),
        method: "GET",
        route: "/integration/v1/routes",
        status_class: 5,
        count: 999n,
      },
    );

    const report = await new ListApiUsageUseCase(apiKeys, users).execute(
      { userId: ADMIN, businessId: CARRIER, days: 3 },
      new Date("2026-10-05T15:00:00.000Z"),
    );

    expect(report.timeZone).toBe("America/Sao_Paulo");
    expect(report.totals).toEqual({ ok: 40, clientError: 3, serverError: 0 });
    expect(report.byDay).toEqual([
      { day: "2026-10-03", total: 3 },
      { day: "2026-10-04", total: 0 },
      { day: "2026-10-05", total: 40 },
    ]);
    expect(report.keys).toEqual([{ id: created.id, name: "ERP", prefix: created.prefix }]);
  });
});
