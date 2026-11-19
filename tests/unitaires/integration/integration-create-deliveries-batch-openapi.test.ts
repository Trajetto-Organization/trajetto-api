import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import {
  MAX_BATCH_DELIVERIES,
  parseBatchEnvelope,
} from "@/schemas/create-integration-deliveries-batch-schema";
import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

/**
 * POST /integration/v1/deliveries/batch as the PUBLIC reference publishes
 * it (plano-escala U-04), read from the running application: what an ERP
 * vendor codes the batch against without talking to us.
 */
type Json = Record<string, any>;

const PATH = "/integration/v1/deliveries/batch";

let document: Json;
let operation: Json;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = (
    await app.inject({ method: "GET", url: "/integration/docs/openapi.json" })
  ).json();
  operation = document.paths?.[PATH]?.post;

  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("the public batch, as published", () => {
  it("is in the portal, behind a key with the single create's scope", () => {
    expect(operation, `${PATH} fora do portal`).toBeDefined();
    expect(operation.operationId).toBe("createDeliveriesBatch");
    expect(operation["x-scopes"]).toEqual(["deliveries:write"]);
    expect(operation.tags).toEqual(
      document.paths["/integration/v1/deliveries"].post.tags,
    );
  });

  it("publishes a body of 1 to 100 deliveries whose example passes the schema and the API's parsers", () => {
    const body = operation.requestBody?.content?.["application/json"] ?? {};
    const list = body.schema.properties.deliveries;

    expect(body.schema.required).toEqual(["deliveries"]);
    expect(body.schema.additionalProperties).toBe(false);
    expect(list).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: MAX_BATCH_DELIVERIES,
    });

    const ajv = new Ajv2020({ strict: false, allErrors: true });

    addFormats(ajv);

    const validate = ajv.compile({
      ...body.schema,
      components: document.components,
    });

    expect(validate(body.example), JSON.stringify(validate.errors)).toBe(true);

    // The envelope, then each element as the use case reads it: its key
    // out, the rest through the single create's own parser.
    for (const element of parseBatchEnvelope(body.example).deliveries) {
      const { idempotency_key: key, ...single } = element as Record<
        string,
        unknown
      >;

      expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      expect(() => parseIntegrationDeliveryBody(single)).not.toThrow();
    }

    // And the published schema refuses what the API refuses.
    expect(validate({ deliveries: [] })).toBe(false);
    expect(validate({ ...body.example, businessId: "x" })).toBe(false);

    // The curl in the description sends that same body.
    const curl = /```bash\n([\s\S]*?)```/.exec(operation.description)?.[1];
    const sent = /-d '([\s\S]*?)'\s*$/m.exec(curl ?? "")?.[1];

    expect(curl).toContain("/deliveries/batch");
    expect(JSON.parse(sent ?? "null")).toEqual(body.example);
  });

  it("answers one result per delivery and the counts, and says each counts one call", () => {
    const ok = operation.responses["200"].content["application/json"];

    expect(Object.keys(ok.schema.properties).sort()).toEqual([
      "created",
      "refused",
      "replayed",
      "results",
    ]);
    expect(ok.example.results[0]).toMatchObject({ index: 0, status: 201 });

    for (const status of ["400", "429", "500", "503"]) {
      expect(operation.responses[status], status).toBeDefined();
    }

    expect(operation.description).toContain(
      "Cada entrega conta como uma requisição",
    );
  });
});
