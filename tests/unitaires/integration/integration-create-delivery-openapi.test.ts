import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * POST /integration/v1/deliveries as the PUBLIC reference publishes it
 * (decision 5.10) — the document an ERP vendor codes against without ever
 * talking to us, read from the running application.
 *
 * The error bodies are checked against what the controller and the error
 * handler really send: a published schema that closed over `{ message }`
 * while the runtime sent `code` too is how a generated client ended up
 * rejecting the real 401 (DOCS-02).
 */
interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

interface Operation {
  operationId?: string;
  description?: string;
  security?: unknown[];
  "x-scopes"?: string[];
  parameters?: Array<{
    in: string;
    name: string;
    required?: boolean;
    description?: string;
  }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema; example?: unknown }>;
    }
  >;
}

let operation: Operation;
let introduction: string;
let catalogue: { scopes: Array<{ scope: string; reserved: boolean }> };
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  const portal = await app.inject({
    method: "GET",
    url: "/integration/docs/openapi.json",
  });

  operation = portal.json().paths["/integration/v1/deliveries"]?.post;
  introduction = String(portal.json().info?.description ?? "");
  catalogue = (
    await app.inject({ method: "GET", url: "/integration/v1/catalogue" })
  ).json();

  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const schemaOf = (status: string): JsonSchema =>
  operation.responses[status]?.content?.["application/json"]?.schema ?? {};

/** Whether a flat body fits a published object schema, strictly. */
function fits(schema: JsonSchema, body: Record<string, unknown>): boolean {
  const properties = Object.keys(schema.properties ?? {});

  return (
    Object.keys(body).every((key) => properties.includes(key)) &&
    (schema.required ?? []).every((key) => key in body)
  );
}

describe("the public create, as published", () => {
  it("is in the public portal, behind a key with the write scope", () => {
    expect(
      operation,
      "POST /integration/v1/deliveries fora do portal",
    ).toBeDefined();

    // The key scheme only; the portal may name the scope in the requirement.
    const security = operation.security as Array<Record<string, string[]>>;

    expect(security.map((requirement) => Object.keys(requirement))).toEqual([
      ["apiKey"],
    ]);
    expect(["", "deliveries:write"]).toContain(security[0].apiKey.join(","));

    expect(operation["x-scopes"]).toEqual(["deliveries:write"]);
    expect(operation.operationId).toBe("createDelivery");
  });

  it("requires the Idempotency-Key and says what repeating it does", () => {
    const header = operation.parameters?.find(
      (parameter) =>
        parameter.in === "header" && parameter.name === "idempotency-key",
    );

    expect(header?.required).toBe(true);
    expect(header?.description).toContain("IDEMPOTENCY_KEY_REUSED");
  });

  it("publishes the body with both ways to name the shipper, closed to unknown fields", () => {
    const body =
      operation.requestBody?.content?.["application/json"]?.schema ?? {};

    for (const field of [
      "shipper_id",
      "shipper_cnpj",
      "recipient_name",
      "cep",
      "items",
    ]) {
      expect(Object.keys(body.properties ?? {}), field).toContain(field);
    }

    // The panel's field name is not the public one.
    expect(Object.keys(body.properties ?? {})).not.toContain("shipperId");
    expect(body.additionalProperties).toBe(false);

    // One of the two, so neither is required on its own; both explained.
    for (const field of ["shipper_id", "shipper_cnpj"]) {
      expect(body.required ?? [], field).not.toContain(field);
      expect(body.properties?.[field]?.description ?? "", field).toMatch(
        /shipper_(id|cnpj)/,
      );
    }
  });

  it("says what the 400 message really is", () => {
    // VALIDATION_ERROR's `message` is the first refused field's sentence (it
    // was the English "Validation Error"); every sentence is in `issues`.
    const message = schemaOf("400").properties?.message?.description ?? "";

    expect(message).not.toContain("Validation Error");
    expect(message).toContain("primeiro campo recusado");
    expect(message).toContain("`issues`");
    expect(message).toContain("MALFORMED_REQUEST");

    expect(schemaOf("500").properties?.message?.description ?? "").toContain(
      "Internal server error",
    );

    // The introduction's "## Erros" says the same.
    expect(introduction).toContain(
      "`VALIDATION_ERROR` ela é a frase do primeiro campo",
    );
    expect(introduction).not.toContain("Validation Error");
  });

  it("says the Idempotency-Key namespace includes the panel's submissions", () => {
    const header = operation.parameters?.find(
      (parameter) =>
        parameter.in === "header" && parameter.name === "idempotency-key",
    );

    expect(header?.description).toMatch(/painel/);
    expect(operation.responses["409"].description ?? "").toMatch(/painel/);
    expect(operation.responses["409"].description ?? "").toContain(
      "shipper_cnpj",
    );
  });

  it("shows an example of what comes back, created and replayed", () => {
    for (const status of ["201", "200"]) {
      const media = operation.responses[status]?.content?.["application/json"];

      expect(media?.example, status).toMatchObject({
        status: "PENDING",
        route: null,
      });
    }
  });

  it("says there is no batch create in v1", () => {
    expect(operation.description ?? "").toMatch(/lote/);
  });

  it("documents the error bodies the API really sends", () => {
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining([
        "400",
        "401",
        "403",
        "404",
        "409",
        "429",
        "500",
        "503",
      ]),
    );

    // The handler's validation refusal.
    expect(
      fits(schemaOf("400"), {
        code: "VALIDATION_ERROR",
        message: "cep: O CEP deve ter exatamente 8 dígitos.",
        issues: ["cep: O CEP deve ter exatamente 8 dígitos."],
      }),
    ).toBe(true);

    // The controller's two 409s, with the delivery in the way.
    for (const code of [
      "IDEMPOTENCY_KEY_REUSED",
      "DELIVERY_INVOICE_KEY_EXISTS",
    ]) {
      expect(
        fits(schemaOf("409"), { code, message: "m", delivery_id: "x" }),
        code,
      ).toBe(true);
      expect(operation.responses["409"].description ?? "", code).toContain(
        code,
      );
    }

    expect(
      fits(schemaOf("404"), { code: "SHIPPER_NOT_FOUND", message: "m" }),
    ).toBe(true);
  });
});

describe("the open catalogue", () => {
  it("no longer calls deliveries:write reserved", () => {
    const write = catalogue.scopes.find(
      (entry) => entry.scope === "deliveries:write",
    );

    expect(write?.reserved).toBe(false);

    expect(
      catalogue.scopes.find((entry) => entry.scope === "webhooks:manage")
        ?.reserved,
    ).toBe(true);
  });
});
