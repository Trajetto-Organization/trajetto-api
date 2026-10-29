import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

/**
 * The request examples of the public reference, read from the live document.
 *
 * The document published no request example, so the web reference built one
 * from the schema: `shipper_id` AND `shipper_cnpj`, and "texto" in the CEP, the
 * UF, the NF-e key, the e-mail and the date. Pasted, it came back 400 with
 * nine issues. Every write now publishes a real body, and here it is held to
 * what a reader will do with it: a generated client validates it against the
 * published JSON Schema, and the API parses it. The E2E contract posts it
 * for real (tests/E2E/public-docs-contract.test.ts).
 *
 * Ajv is the validator Fastify itself compiles schemas with (already
 * installed through @fastify/ajv-compiler); 2020-12 is OpenAPI 3.1's dialect.
 */
type Json = Record<string, any>;

let document: Json;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = (
    await app.inject({ method: "GET", url: "/integration/docs/openapi.json" })
  ).json();
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function writes(): Array<{ id: string; operation: Json }> {
  return Object.entries(document.paths as Record<string, Json>).flatMap(
    ([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => (operation as Json)?.requestBody)
        .map(([method, operation]) => ({
          id: `${method.toUpperCase()} ${path}`,
          operation: operation as Json,
        })),
  );
}

function jsonBody(operation: Json): Json {
  return operation.requestBody.content["application/json"];
}

/** What a strict generated client does with the published schema. */
function publishedSchemaErrors(schema: Json, value: unknown): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  addFormats(ajv);

  // The body's `$ref`s point at the document's components.
  const validate = ajv.compile({ ...schema, components: document.components });

  return validate(value)
    ? []
    : (validate.errors ?? []).map(
        (error) => `${error.instancePath || "corpo"} ${error.message}`,
      );
}

/** The JSON inside the `-d '…'` of the operation description's curl block. */
function descriptionCurlBody(description: string): unknown {
  const block = /```bash\n([\s\S]*?)```/.exec(description)?.[1] ?? "";
  const body = /-d '([\s\S]*?)'\s*$/m.exec(block)?.[1];

  return body === undefined ? undefined : JSON.parse(body);
}

describe("the request examples of the public reference", () => {
  it("exist on every write, so no renderer has to invent a body", () => {
    const found = writes();

    expect(found.map(({ id }) => id)).toContain(
      "POST /integration/v1/deliveries",
    );

    for (const { id, operation } of found) {
      expect(jsonBody(operation).example, id).toBeDefined();
    }
  });

  it("pass the JSON Schema the document publishes next to them", () => {
    for (const { id, operation } of writes()) {
      const media = jsonBody(operation);

      expect(publishedSchemaErrors(media.schema, media.example), id).toEqual(
        [],
      );
    }
  });

  it("would be refused by that schema if they named the shipper twice or kept a mask", () => {
    // The check above can fail: the invented body and the masked one both do.
    const media = jsonBody(document.paths["/integration/v1/deliveries"].post);

    expect(
      publishedSchemaErrors(media.schema, {
        ...media.example,
        cep: "13010-000",
      }),
    ).not.toEqual([]);
    expect(
      publishedSchemaErrors(media.schema, { ...media.example, uf: "texto" }),
    ).not.toEqual([]);
  });

  it("are a body the API parses, naming the shipper once", () => {
    const { example } = jsonBody(
      document.paths["/integration/v1/deliveries"].post,
    );

    expect(() => parseIntegrationDeliveryBody(example)).not.toThrow();
    expect(
      [example.shipper_id, example.shipper_cnpj].filter(
        (value) => value != null,
      ),
    ).toHaveLength(1);
  });

  it("describe the same document as the curl in the operation's description", () => {
    const operation = document.paths["/integration/v1/deliveries"].post;

    // A description without its own curl has nothing to drift from.
    if (!/```bash[\s\S]*curl/.test(operation.description)) return;

    const described = descriptionCurlBody(operation.description);

    expect(described, "um curl com -d '…' na descrição").toBeDefined();

    // Masks aside (the description sends them), the API reads the same delivery.
    expect(parseIntegrationDeliveryBody(described)).toEqual(
      parseIntegrationDeliveryBody(jsonBody(operation).example),
    );
  });
});
