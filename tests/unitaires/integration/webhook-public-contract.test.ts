import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as apiKeyRules from "@/shared/integration/api-key-rules";

import {
  deliveryEventPayload,
  routeEventPayload,
} from "@/shared/integration/announce";

import { buildPublicApiDocument } from "@/shared/integration/public-docs";
import { reservedHeaderNames } from "@/shared/integration/webhook-destination";
import { ALL_TOPICS, TOPIC_FAMILY } from "@/shared/integration/webhook-catalogue";

import {
  REPLAY_WINDOW_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "@/shared/integration/webhook-dispatch-rules";

import { buildCatalogue } from "@/routes/documentation/integration-documentation";

/**
 * What the public reference promises about webhooks, checked against the
 * code that keeps the promise.
 *
 * An integrator implements a receiver from this text alone. Every number in
 * it — how long we retry, how long we wait — and every name — the headers,
 * the scopes, the fields of a payload — is something their code will depend
 * on, so each one is read from the constant that decides it rather than
 * written a second time by hand.
 */
const description = String(buildPublicApiDocument({}).info?.description);

const schemas = () =>
  (
    buildPublicApiDocument({}).components as {
      schemas?: Record<string, { properties?: Record<string, unknown> }>;
    }
  ).schemas ?? {};

describe("how a receiver deduplicates", () => {
  it("names every header we send, and which one is stable", () => {
    for (const header of [
      "X-Trajetto-Event-Id",
      "X-Trajetto-Delivery",
      "X-Trajetto-Topic",
      "X-Trajetto-Signature",
    ]) {
      expect(description).toContain(header);
    }
  });

  it("states the guarantee and the key to deduplicate on", () => {
    expect(description).toContain("pelo menos uma vez");
    expect(description).toMatch(/deduplique/i);
  });

  it("states the timeout, the 410 and the redirects, from the code", () => {
    expect(description).toContain(`${WEBHOOK_TIMEOUT_MS / 1000} s`);
    expect(description).toContain("410");
    expect(description).toMatch(/redirecionamento/i);
  });

  it("keeps the event id out of a customer's own headers", () => {
    // Ours are written after theirs, and a customer header with this name
    // would otherwise be a way to forge the dedup key.
    expect(reservedHeaderNames({ "X-Trajetto-Event-Id": "x" })).toEqual([
      "X-Trajetto-Event-Id",
    ]);
  });
});

describe("how long we keep trying", () => {
  const total = WEBHOOK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

  it("says what the retry schedule adds up to", () => {
    // The schedule is 30 s, 2 min, 10 min, 1 h and 6 h: about seven hours.
    // "Até seis horas" had an integrator size their reprocessing window one
    // attempt short.
    expect(description).not.toContain("seis horas");
    expect(description).toContain(`cerca de ${Math.round(total / 3_600_000)} horas`);
    expect(description).toContain(`${WEBHOOK_MAX_ATTEMPTS} tentativas`);
    expect(description).toContain(`${REPLAY_WINDOW_DAYS} dias`);
  });
});

describe("what a webhook carries", () => {
  it("publishes the envelope every event arrives in", () => {
    expect(Object.keys(schemas().WebhookEnvelope?.properties ?? {})).toEqual([
      "id",
      "sequence",
      "topic",
      "created_at",
      "data",
    ]);
  });

  it("publishes the document fields the builder actually writes", () => {
    expect(Object.keys(schemas().WebhookDocumentData?.properties ?? {})).toEqual(
      Object.keys(deliveryEventPayload({ id: "x" })),
    );
  });

  it("publishes the route fields the builder actually writes", () => {
    expect(Object.keys(schemas().WebhookRouteData?.properties ?? {})).toEqual(
      Object.keys(routeEventPayload({ id: "x", code: 1 })),
    );
  });

  it("tells, for every topic, which shape its data takes", () => {
    for (const topic of ALL_TOPICS) {
      expect(description, topic).toContain(`\`${topic}\``);
    }
  });
});

describe("the scopes a key can be given", () => {
  // The scopes the public routes actually require, read from where they are
  // required. A scope nothing requires is a promise of an endpoint that is not
  // there: a customer creates a `deliveries:write` key to push orders from
  // their ERP and finds nothing to push them to.
  const required = new Set(
    [
      ...readFileSync(
        resolve(process.cwd(), "src/routes/integration-routes.ts"),
        "utf8",
      ).matchAll(/verifyApiScope\("([^"]+)"\)/g),
    ].map((match) => match[1]),
  );

  const reserved: readonly string[] =
    (apiKeyRules as { RESERVED_API_SCOPES?: readonly string[] })
      .RESERVED_API_SCOPES ?? [];

  it("either opens an endpoint or says it is reserved", () => {
    const dishonest = apiKeyRules.API_SCOPES.filter(
      (scope) =>
        !required.has(scope) &&
        !(
          reserved.includes(scope) &&
          apiKeyRules.SCOPE_DESCRIPTIONS[scope].startsWith("Reservado")
        ),
    );

    expect(dishonest).toEqual([]);
  });

  it("does not call a scope reserved when a route requires it", () => {
    for (const scope of reserved) {
      expect(required.has(scope), scope).toBe(false);
    }
  });

  it("marks the reserved ones in the open catalogue", () => {
    const catalogue = buildCatalogue("v1", TOPIC_FAMILY);

    for (const entry of catalogue.scopes) {
      expect(
        (entry as { reserved?: boolean }).reserved,
        entry.scope,
      ).toBe(reserved.includes(entry.scope));
    }
  });
});
