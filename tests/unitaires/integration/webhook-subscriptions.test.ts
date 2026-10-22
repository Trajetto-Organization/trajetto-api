import { describe, expect, it } from "vitest";

import {
  createApiKeySchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";

import {
  DOCUMENT_TOPICS,
  FAMILY_WILDCARDS,
  ROUTE_TOPICS,
  TOPIC_WILDCARDS,
  endpointWantsTopic,
} from "@/shared/integration/webhook-catalogue";

/**
 * What an endpoint can subscribe to, and what the admin screens may send.
 *
 * "Todos os eventos" of Documentos saved `document.*`. The dispatcher matches
 * a wildcard by topic PREFIX and no topic starts with "document.", so those
 * endpoints received no document event at all, and nothing anywhere said so
 * (DLVB-22, decision 5.9). The schema accepted any `[a-z]+.*`.
 */
const endpoint = {
  name: "ERP do embarcador",
  url: "https://erp.exemplo.com.br/webhooks",
  topics: ["delivery.created"],
};

function refusal(input: Record<string, unknown>): string | null {
  const parsed = saveWebhookEndpointSchema.safeParse({ ...endpoint, ...input });

  return parsed.success
    ? null
    : parsed.error.issues.map((issue) => issue.message).join(" | ");
}

describe("the wildcards of each family", () => {
  it("cover every document topic with delivery.*, occurrence.* and proof.*", () => {
    expect(FAMILY_WILDCARDS.document).toEqual([
      "delivery.*",
      "occurrence.*",
      "proof.*",
    ]);

    for (const topic of DOCUMENT_TOPICS) {
      expect(endpointWantsTopic(FAMILY_WILDCARDS.document, topic), topic).toBe(
        true,
      );
    }

    for (const topic of ROUTE_TOPICS) {
      expect(endpointWantsTopic(FAMILY_WILDCARDS.document, topic), topic).toBe(
        false,
      );
    }
  });

  it("cover every route topic with route.*, and nothing else", () => {
    expect(FAMILY_WILDCARDS.route).toEqual(["route.*"]);

    for (const topic of ROUTE_TOPICS) {
      expect(endpointWantsTopic(FAMILY_WILDCARDS.route, topic), topic).toBe(
        true,
      );
    }

    for (const topic of DOCUMENT_TOPICS) {
      expect(endpointWantsTopic(FAMILY_WILDCARDS.route, topic), topic).toBe(
        false,
      );
    }
  });

  it("still deliver to a document.* saved by the previous release mid-rollout", () => {
    // The migration rewrote every stored `document.*`, but an old replica can
    // save one more while the deploy rolls. It must not go mute again.
    for (const topic of DOCUMENT_TOPICS) {
      expect(endpointWantsTopic(["document.*"], topic), topic).toBe(true);
    }

    expect(endpointWantsTopic(["document.*"], "route.started")).toBe(false);
  });
});

describe("the subscriptions the API accepts", () => {
  it("takes catalogue names and the known wildcards", () => {
    expect(refusal({ topics: ["route.*"] })).toBeNull();
    expect(refusal({ topics: FAMILY_WILDCARDS.document })).toBeNull();
    expect(
      refusal({ topics: [...TOPIC_WILDCARDS, "delivery.delivered"] }),
    ).toBeNull();
  });

  it("refuses a family name, an invented prefix and a bare star, naming them", () => {
    const message = refusal({
      topics: ["document.*", "banana.*", "*", "delivery.*"],
    });

    expect(message).toMatch(
      /não existem no catálogo: document\.\*, banana\.\*, \*/,
    );
    expect(message).toMatch(/delivery\.\*, occurrence\.\*, proof\.\*/);
  });

  it("stores each subscription once", () => {
    const parsed = saveWebhookEndpointSchema.parse({
      ...endpoint,
      topics: ["delivery.*", "delivery.*", "route.released"],
    });

    expect(parsed.topics).toEqual(["delivery.*", "route.released"]);
  });
});

describe("the URL an endpoint is saved with (DLVB-24)", () => {
  it("is at most 2,048 characters", () => {
    const base = "https://erp.exemplo.com.br/";

    expect(refusal({ url: base + "a".repeat(2048 - base.length) })).toBeNull();
    expect(refusal({ url: base + "a".repeat(2049 - base.length) })).toMatch(
      /2\.048/,
    );
  });

  it("refuses at save an address that can never be reached", () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://192.168.1.10:8443/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://erp.internal/hook",
      "https://metadata.google.internal/",
    ]) {
      expect(refusal({ url }), url).toMatch(/alcançável pela internet/);
    }
  });

  it("accepts a public literal and any public name", () => {
    expect(refusal({ url: "https://8.8.8.8/hook" })).toBeNull();
    expect(refusal({ url: "https://[2606:4700::1111]/hook" })).toBeNull();
    expect(refusal({ url: "https://erp.exemplo.com.br/hook" })).toBeNull();
  });
});

describe("the names a person types", () => {
  it("follow the product's text rules on endpoints and keys", () => {
    expect(refusal({ name: "ERP  do embarcador" })).toMatch(
      /espaços consecutivos/,
    );
    expect(refusal({ name: " ERP" })).toMatch(/começar ou terminar com espaço/);

    expect(
      createApiKeySchema.safeParse({
        name: "ERP  Protheus",
        scopes: ["deliveries:read"],
      }).success,
    ).toBe(false);
  });
});

describe("the rate of a new key (DLVB-20)", () => {
  function keyRefusal(rate: unknown): string | null {
    const parsed = createApiKeySchema.safeParse({
      name: "ERP Protheus",
      scopes: ["deliveries:read"],
      rate_limit_per_minute: rate,
    });

    return parsed.success ? null : parsed.error.issues[0].message;
  }

  it("answers a decimal, a text and an out-of-range number in Portuguese", () => {
    // `12.5` used to come back as zod's "Expected integer, received float".
    expect(keyRefusal(12.5)).toBe(
      "O limite por minuto deve ser um número inteiro, sem casas decimais.",
    );
    expect(keyRefusal("--")).toBe(
      "O limite por minuto deve ser um número inteiro de requisições.",
    );
    expect(keyRefusal(5)).toBe(
      "O limite mínimo é de 10 requisições por minuto.",
    );
    expect(keyRefusal(6001)).toMatch(/vai até 6\.000 requisições por minuto/);
  });

  it("defaults to 120 when omitted", () => {
    expect(
      createApiKeySchema.parse({
        name: "ERP Protheus",
        scopes: ["deliveries:read"],
      }).rate_limit_per_minute,
    ).toBe(120);
  });
});
