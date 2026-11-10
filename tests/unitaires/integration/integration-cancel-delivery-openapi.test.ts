import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { DeliveryStatus } from "@prisma/client";

import { parseCancelIntegrationDeliveryBody } from "@/schemas/cancel-integration-delivery-schema";
import { NOT_CANCELLABLE_STATUSES } from "@/shared/integration/cancel-delivery-rules";

/**
 * POST /integration/v1/deliveries/{id}/cancel as the PUBLIC reference
 * publishes it (L9, D49), read from the running application: the document an
 * ERP vendor codes the cancel against without talking to us.
 */
type Json = Record<string, any>;

const PATH = "/integration/v1/deliveries/{id}/cancel";

let document: Json;
let operation: Json;
let catalogue: { scopes: Array<{ scope: string; reserved: boolean }> };
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = (
    await app.inject({ method: "GET", url: "/integration/docs/openapi.json" })
  ).json();
  operation = document.paths?.[PATH]?.post;
  catalogue = (
    await app.inject({ method: "GET", url: "/integration/v1/catalogue" })
  ).json();

  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const media = (status: string): Json =>
  operation.responses[status]?.content?.["application/json"] ?? {};

/** Whether a flat body fits a published object schema, strictly. */
function fits(schema: Json, body: Record<string, unknown>): boolean {
  const properties = Object.keys(schema.properties ?? {});

  return (
    Object.keys(body).every((key) => properties.includes(key)) &&
    (schema.required ?? []).every((key: string) => key in body)
  );
}

describe("the public cancel, as published", () => {
  it("is in the public portal, behind a key with its own scope", () => {
    expect(operation, `${PATH} fora do portal`).toBeDefined();
    expect(operation.operationId).toBe("cancelDelivery");
    expect(operation["x-scopes"]).toEqual(["deliveries:cancel"]);
    expect(
      (operation.security as Array<Record<string, string[]>>).map(
        (requirement) => Object.keys(requirement),
      ),
    ).toEqual([["apiKey"]]);

    // Under Entregas, with the create and the reads.
    expect(operation.tags).toEqual(
      document.paths["/integration/v1/deliveries"].post.tags,
    );
  });

  it("publishes a body whose example passes its JSON Schema and the API's parser", () => {
    const body = operation.requestBody?.content?.["application/json"] ?? {};

    expect(body.schema.required).toEqual(["reason"]);
    expect(body.schema.additionalProperties).toBe(false);
    expect(body.schema.properties.reason).toMatchObject({
      type: "string",
      minLength: 3,
      maxLength: 500,
    });

    const ajv = new Ajv2020({ strict: false, allErrors: true });

    addFormats(ajv);

    const validate = ajv.compile({
      ...body.schema,
      components: document.components,
    });

    expect(validate(body.example), JSON.stringify(validate.errors)).toBe(true);
    expect(() =>
      parseCancelIntegrationDeliveryBody(body.example),
    ).not.toThrow();

    // And the published schema refuses what the API refuses.
    expect(validate({})).toBe(false);
    expect(validate({ ...body.example, motivo: "x" })).toBe(false);

    // The curl in the description sends that same body.
    const curl = /```bash\n([\s\S]*?)```/.exec(operation.description)?.[1];
    const sent = /-d '([\s\S]*?)'\s*$/m.exec(curl ?? "")?.[1];

    expect(curl).toContain("/cancel");
    expect(JSON.parse(sent ?? "null")).toEqual(body.example);
  });

  it("says it takes no Idempotency-Key, and why repeating is safe", () => {
    expect(
      (operation.parameters ?? []).filter(
        (parameter: Json) =>
          parameter.in === "header" && parameter.name === "idempotency-key",
      ),
    ).toEqual([]);

    expect(operation.description).toContain("Sem `Idempotency-Key`");
    expect(operation.description).toContain("idempotent-replayed: true");
    expect(operation.responses["200"].description).toContain(
      "idempotent-replayed",
    );
  });

  it("shows what a cancel answers: the identifiers and the status, not the delivery", () => {
    expect(media("200").example).toMatchObject({
      status: "CANCELLED",
      status_label: "Cancelada",
    });
    expect(Object.keys(media("200").schema.properties).sort()).toEqual([
      "code",
      "id",
      "invoice_key",
      "status",
      "status_label",
      "updated_at",
    ]);
  });

  it("documents the refusals the API really sends", () => {
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining([
        "200",
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

    // The controller's 409, with the status in the way; and the conflict.
    expect(
      fits(media("409").schema, {
        code: "DELIVERY_NOT_CANCELLABLE",
        message: "m",
        delivery_status: "IN_TRANSIT",
      }),
    ).toBe(true);
    expect(
      fits(media("409").schema, {
        code: "DELIVERY_STATUS_CONFLICT",
        message: "m",
      }),
    ).toBe(true);
    // The statuses the verdict table refuses, no more and no fewer: a closed
    // schema that missed one would make a strict client reject the real 409.
    expect(media("409").schema.properties.delivery_status.enum).toEqual(
      NOT_CANCELLABLE_STATUSES,
    );

    for (const status of Object.values(DeliveryStatus)) {
      expect(
        new RegExp(`\\b${status}\\b`).test(
          operation.responses["409"].description,
        ),
        status,
      ).toBe(NOT_CANCELLABLE_STATUSES.includes(status as never));
    }

    for (const code of [
      "DELIVERY_NOT_CANCELLABLE",
      "DELIVERY_STATUS_CONFLICT",
    ]) {
      expect(media("409").schema.properties.code.description, code).toContain(
        code,
      );
    }

    expect(fits(media("404").schema, { code: "NOT_FOUND", message: "m" })).toBe(
      true,
    );

    // A write key is not a cancel key.
    expect(operation.responses["403"].description ?? "").toMatch(
      /MISSING_API_SCOPE/,
    );
  });

  it("says a repeat after a 500 or a 503 is safe without a key", () => {
    for (const status of ["500", "503"]) {
      expect(operation.responses[status].description, status).toContain(
        "idempotent-replayed: true",
      );
    }

    // The create's advice ("repita com a MESMA Idempotency-Key") is not
    // given to a call that has none. Red before on the 503: the keyed
    // routes' generic outage paragraph followed the cancel's own.
    for (const status of ["500", "503"]) {
      expect(operation.responses[status].description, status).not.toContain(
        "Idempotency-Key",
      );
    }
  });
});

describe("the open catalogue", () => {
  it("lists deliveries:cancel as a scope a key can be issued with", () => {
    expect(
      catalogue.scopes.find((entry) => entry.scope === "deliveries:cancel")
        ?.reserved,
    ).toBe(false);
  });
});

describe("the portal's introduction", () => {
  it("has a section on cancelling, and says the write scope does not cancel", () => {
    const introduction = String(document.info?.description ?? "");

    expect(introduction).toContain("## Cancelar entregas");
    expect(introduction).toContain("`deliveries:write` não basta");
  });
});
