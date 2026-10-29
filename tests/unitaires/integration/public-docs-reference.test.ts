import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";
import {
  API_SCOPES,
  BUSINESS_API_RATE_PER_MINUTE,
  PLATFORM_API_KEY_RATE_CEILING,
  RESERVED_API_SCOPES,
  TENANT_API_KEY_RATE_CEILING,
} from "@/shared/integration/api-key-rules";
import { MAX_API_KEY_AUTH_FAILURES_PER_MINUTE } from "@/shared/integration/integration-rate-guard";
import { buildPublicApiDocument } from "@/shared/integration/public-docs";
import { ALL_TOPICS } from "@/shared/integration/webhook-catalogue";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  REPLAY_WINDOW_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "@/shared/integration/webhook-dispatch-rules";
import { TOPIC_PAYLOAD } from "@/shared/integration/webhook-payload-schemas";
import { SIGNATURE_TOLERANCE_SECONDS } from "@/shared/integration/webhook-signature";

import {
  OTHER_TAG,
  RESOURCE_TAGS,
  toOpenApi31,
} from "@/routes/documentation/public-docs-reference";

/**
 * The public reference as the API serves it, which is what the web portal
 * renders and what a code generator reads.
 *
 * It was OpenAPI 3.0 with the webhooks as loose schemas, one English-titled
 * `integration` tag, no operationId, no servers, error bodies published as
 * `{ message }` while the handler sends `{ code, message }`, and the numbers
 * integrators size a receiver from only in prose. Every assertion here reads
 * the live document, not the builder in isolation.
 */
type Json = Record<string, any>;

let document: Json;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/integration/docs/openapi.json",
  });

  document = response.json();
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function operations(): Array<{ id: string; path: string; operation: Json }> {
  return Object.entries(document.paths as Record<string, Json>).flatMap(
    ([path, item]) =>
      Object.entries(item)
        .filter(([method]) => METHODS.has(method))
        .map(([method, operation]) => ({
          id: `${method.toUpperCase()} ${path}`,
          path,
          operation: operation as Json,
        })),
  );
}

function keyed() {
  return operations().filter(({ operation }) =>
    (operation.security ?? []).some(
      (requirement: Json) => "apiKey" in requirement,
    ),
  );
}

/** Every `nullable` KEYWORD left anywhere (a property named so is an object). */
function nullableKeywords(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) =>
      nullableKeywords(item, `${path}[${index}]`),
    );
  }

  if (!node || typeof node !== "object") return [];

  return Object.entries(node as Json).flatMap(([key, value]) =>
    key === "nullable" && typeof value === "boolean"
      ? [path]
      : nullableKeywords(value, `${path}.${key}`),
  );
}

function jsonSchema(response: Json): Json | undefined {
  return response?.content?.["application/json"]?.schema;
}

describe("the public reference's shape", () => {
  it("is OpenAPI 3.1, with no 3.0 nullable left for a strict validator to refuse", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(nullableKeywords(document)).toEqual([]);

    const page = jsonSchema(
      document.paths["/integration/v1/deliveries"].get.responses["200"],
    );

    expect(page?.properties.next_cursor.type).toEqual(["string", "null"]);
  });

  it("groups every endpoint under its resource, in Portuguese", () => {
    const names = Object.values(RESOURCE_TAGS).map((tag) => tag.name);

    for (const { id, operation } of operations()) {
      expect(operation.tags, id).toHaveLength(1);
      expect(names, id).toContain(operation.tags[0]);
      expect(operation.tags[0], id).not.toBe(OTHER_TAG.name);
    }

    const used = new Set(
      operations().map(({ operation }) => operation.tags[0]),
    );

    expect(document.tags.map((tag: Json) => tag.name)).toEqual(
      names.filter((name) => used.has(name)),
    );
  });

  it("names every operation once, for code generators", () => {
    const ids = operations().map(({ id, operation }) => [
      id,
      operation.operationId,
    ]);

    for (const [id, operationId] of ids) {
      expect(operationId, id).toMatch(/^[a-z][A-Za-z]+$/);
    }

    expect(new Set(ids.map(([, operationId]) => operationId)).size).toBe(
      ids.length,
    );
  });

  it("titles every endpoint in Portuguese", () => {
    for (const { id, operation } of operations()) {
      expect(operation.summary, id).toBeTruthy();
      // English function words that are not also Portuguese ones.
      expect(operation.summary, id).not.toMatch(
        /\b(the|of|one|what|this|every|which)\b/i,
      );
    }
  });

  it("names the scope each keyed endpoint needs, next to the lock", () => {
    const grantable = API_SCOPES.filter(
      (scope) => !RESERVED_API_SCOPES.includes(scope),
    );

    for (const { id, operation } of keyed()) {
      const [requirement] = operation.security;

      expect(requirement.apiKey, id).toHaveLength(1);
      expect(grantable, id).toContain(requirement.apiKey[0]);
      expect(operation["x-scopes"], id).toEqual(requirement.apiKey);
    }
  });
});

describe("what every answer carries", () => {
  it("publishes x-request-id on every response, and retry-after on every 503", () => {
    for (const { id, operation } of operations()) {
      for (const [status, response] of Object.entries(
        operation.responses as Json,
      )) {
        expect(
          Object.keys(response.headers ?? {}),
          `${id} ${status}`,
        ).toContain("x-request-id");

        if (status === "503") {
          expect(Object.keys(response.headers ?? {}), `${id} 503`).toContain(
            "retry-after",
          );
        }
      }
    }
  });

  it("publishes every refusal with the code the client decides on", () => {
    for (const { id, operation } of operations()) {
      for (const [status, response] of Object.entries(
        operation.responses as Json,
      )) {
        if (Number(status) < 400) continue;

        const schema = jsonSchema(response);

        // Declared, so a strict client keeps it. The E2E contract holds the
        // real bodies to these schemas.
        expect(schema?.properties?.code, `${id} ${status}`).toBeDefined();
        expect(schema?.properties?.message, `${id} ${status}`).toBeDefined();
      }
    }
  });

  it("documents the database outage on every keyed endpoint", () => {
    for (const { id, operation } of keyed()) {
      const schema = jsonSchema(operation.responses["503"]);

      expect(schema?.properties?.code?.enum, id).toEqual([
        "SERVICE_UNAVAILABLE",
      ]);
      expect(schema?.required, id).toContain("requestId");
      expect(operation.responses["503"].description, id).toContain(
        `${DATABASE_RETRY_AFTER_SECONDS} s`,
      );
    }
  });

  it("publishes the 500 as the handler sends it", () => {
    for (const { id, operation } of operations()) {
      const schema = jsonSchema(operation.responses["500"]);

      expect(Object.keys(schema?.properties ?? {}), id).toEqual(
        expect.arrayContaining(["code", "status", "message", "requestId"]),
      );
    }
  });
});

describe("the webhooks", () => {
  it("are published as the requests we make, one per topic", () => {
    expect(Object.keys(document.webhooks)).toEqual(ALL_TOPICS);

    for (const topic of ALL_TOPICS) {
      const post = document.webhooks[topic].post;

      expect(
        post.parameters.map((parameter: Json) => parameter.name),
        topic,
      ).toEqual([
        "X-Trajetto-Event-Id",
        "X-Trajetto-Delivery",
        "X-Trajetto-Topic",
        "X-Trajetto-Signature",
      ]);

      const body = post.requestBody.content["application/json"].schema;

      expect(body.properties.topic.enum, topic).toEqual([topic]);
      expect(body.properties.data.$ref, topic).toBe(
        `#/components/schemas/${TOPIC_PAYLOAD[topic]}`,
      );
      expect(
        document.components.schemas[TOPIC_PAYLOAD[topic]],
        topic,
      ).toBeDefined();
    }
  });
});

describe("the numbers the guides print", () => {
  it("come from the constants that enforce them", () => {
    expect(document["x-trajetto-limits"]).toMatchObject({
      key_per_minute_tenant_max: TENANT_API_KEY_RATE_CEILING,
      key_per_minute_platform_max: PLATFORM_API_KEY_RATE_CEILING,
      business_per_minute: BUSINESS_API_RATE_PER_MINUTE,
      invalid_keys_per_address_per_minute: MAX_API_KEY_AUTH_FAILURES_PER_MINUTE,
      service_unavailable_retry_after_seconds: DATABASE_RETRY_AFTER_SECONDS,
    });

    expect(document["x-trajetto-webhooks"]).toMatchObject({
      timeout_seconds: WEBHOOK_TIMEOUT_MS / 1000,
      retry_delays_seconds: WEBHOOK_RETRY_DELAYS_MS.map(
        (delay) => delay / 1000,
      ),
      max_attempts: WEBHOOK_MAX_ATTEMPTS,
      max_consecutive_failures: MAX_CONSECUTIVE_FAILURES,
      replay_window_days: REPLAY_WINDOW_DAYS,
      max_endpoints_per_business: MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
      signature: {
        secret_prefix: "whsec_",
        tolerance_seconds: SIGNATURE_TOLERANCE_SECONDS,
      },
    });

    expect(
      document["x-trajetto-webhooks"].topics.map((entry: Json) => entry.topic),
    ).toEqual(ALL_TOPICS);

    expect(
      document["x-trajetto-authentication"].scopes.map(
        (entry: Json) => entry.scope,
      ),
    ).toEqual([...API_SCOPES]);
  });
});

describe("the introduction", () => {
  const description = () => String(document.info.description);

  it("is organised in headings a renderer can index", () => {
    for (const heading of [
      "## Autenticação",
      "## Paginação e sincronização",
      "## Erros",
      "## Limites",
      "## Webhooks",
      "## Assinatura",
      "## Troca de segredo",
      "## Tópicos",
    ]) {
      expect(description()).toContain(heading);
    }

    // The old bold leads ("**Paginação.** ...") left one block with no index.
    expect(description()).not.toMatch(/^\*\*[^*\n]+\.\*\*/m);
  });

  it("states the order of the lists and the incremental sync recipe", () => {
    expect(description()).toMatch(/ordem do `id`, crescente/);
    expect(description()).toContain("UUID v7");
    expect(description()).toMatch(/instante em que a varredura COMEÇA/);
    expect(description()).toMatch(/deduplique pelo `id`/i);
  });

  it("describes the error body and the request id", () => {
    expect(description()).toContain("`{ code, message }`");
    expect(description()).toContain("`issues`");
    expect(description()).toContain("`x-request-id`");
  });

  it("states both ceilings and the 503", () => {
    expect(description()).toContain(
      `${BUSINESS_API_RATE_PER_MINUTE} por minuto`,
    );
    expect(description()).toContain("429 `RATE_LIMITED`");
    expect(description()).toContain("`SERVICE_UNAVAILABLE`");
  });
});

describe("where to call and where to read", () => {
  it("comes from the options, and stays out when not configured", () => {
    const configured = buildPublicApiDocument(
      {},
      {
        serverUrl: "https://api.exemplo.com.br",
        portalUrl: "https://www.exemplo.com.br/docs",
        environment: "staging",
      },
    );

    expect(configured.servers).toEqual([
      { url: "https://api.exemplo.com.br", description: "Homologação" },
    ]);
    expect((configured.externalDocs as Json).url).toBe(
      "https://www.exemplo.com.br/docs",
    );

    const bare = buildPublicApiDocument({}, {});

    expect(bare.servers).toBeUndefined();
    expect(bare.externalDocs).toBeUndefined();
  });
});

describe("toOpenApi31", () => {
  it("turns nullable into a null type, a null branch or a null enum value", () => {
    expect(toOpenApi31({ type: "string", nullable: true })).toEqual({
      type: ["string", "null"],
    });

    expect(
      toOpenApi31({ $ref: "#/components/schemas/X", nullable: true }),
    ).toEqual({
      anyOf: [{ $ref: "#/components/schemas/X" }, { type: "null" }],
    });

    expect(
      toOpenApi31({
        anyOf: [{ type: "string" }, { type: "number" }],
        nullable: true,
      }),
    ).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    });

    expect(
      toOpenApi31({ type: "string", enum: ["A"], nullable: true }),
    ).toEqual({
      type: ["string", "null"],
      enum: ["A", null],
    });

    expect(toOpenApi31({ type: "string", nullable: false })).toEqual({
      type: "string",
    });
  });

  it("keeps a property named nullable and leaves examples alone", () => {
    expect(
      toOpenApi31({
        type: "object",
        properties: { nullable: { type: "boolean" } },
        example: { nullable: true },
      }),
    ).toEqual({
      type: "object",
      properties: { nullable: { type: "boolean" } },
      example: { nullable: true },
    });
  });

  it("turns a boolean exclusive bound into the numeric one", () => {
    expect(
      toOpenApi31({ type: "number", minimum: 0, exclusiveMinimum: true }),
    ).toEqual({
      type: "number",
      exclusiveMinimum: 0,
    });

    expect(
      toOpenApi31({ type: "number", maximum: 5, exclusiveMaximum: false }),
    ).toEqual({
      type: "number",
      maximum: 5,
    });
  });
});
