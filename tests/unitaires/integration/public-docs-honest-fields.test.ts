import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREATE_DELIVERY_REQUEST_BODY } from "@/routes/documentation/public-docs-examples";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * Sentences of the PUBLIC document that must say what the API really does
 * (decision 11.3), read from the running application:
 *
 *   - a 400's `message` is the first refused field's sentence on
 *     VALIDATION_ERROR and the JSON parser's reason on MALFORMED_REQUEST;
 *   - every refusal of the public create carries `code`, so it is required;
 *   - the create's curl posts the very body the document publishes;
 *   - the create accepts masks that the cleaned schema does not show;
 *   - on /events, `updated_since` filters on the arrival, not on occurred_at.
 */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  anyOf?: JsonSchema[];
}

interface Operation {
  description?: string;
  parameters?: Array<{ in: string; name: string; description?: string }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

let paths: Record<string, Record<string, Operation>>;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  const portal = await app.inject({ method: "GET", url: "/integration/docs/openapi.json" });

  paths = portal.json().paths;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const bodyOf = (operation: Operation, status: string): JsonSchema =>
  operation.responses[status]?.content?.["application/json"]?.schema ?? {};

const createDelivery = () => paths["/integration/v1/deliveries"].post;

describe("the public document says what the API really sends", () => {
  it("does not promise a Portuguese sentence in a read's 400 message", () => {
    const message = bodyOf(paths["/integration/v1/deliveries"].get, "400").properties?.message;

    expect(message?.description).not.toMatch(/pronta para mostrar/);
    expect(message?.description).toContain("primeiro campo recusado");
    expect(message?.description).toContain("MALFORMED_REQUEST");
  });

  it("publishes `code` as required on every refusal of the public create", () => {
    const refusals = Object.keys(createDelivery().responses).filter(
      (status) => ["400", "404", "409"].includes(status),
    );

    expect(refusals.length).toBeGreaterThan(0);

    for (const status of refusals) {
      expect(bodyOf(createDelivery(), status).required, status).toContain("code");
    }
  });

  it("shows in the create's curl the body the document publishes", () => {
    const curl = createDelivery().description ?? "";
    const data = /-d '([\s\S]*?)'\n/.exec(curl)?.[1];

    expect(data, "curl sem -d").toBeDefined();
    expect(JSON.parse(data!)).toEqual(CREATE_DELIVERY_REQUEST_BODY);
  });

  it("says the create accepts masks on the fields published cleaned", () => {
    const fields = createDelivery().requestBody?.content?.["application/json"]?.schema?.properties ?? {};

    for (const name of ["cep", "recipient_document", "recipient_telephone"]) {
      expect(fields[name]?.description, name).toMatch(/com ou sem máscara/);
    }

    expect(fields.uf?.description).toMatch(/minúscula/);
  });

  it("says /events filters on the arrival, not on occurred_at", () => {
    const parameter = paths["/integration/v1/events"].get.parameters?.find(
      (entry) => entry.name === "updated_since",
    );

    expect(parameter?.description).toMatch(/chegou ao Trajetto/);
    expect(parameter?.description).toMatch(/occurred_at/);
  });
});
