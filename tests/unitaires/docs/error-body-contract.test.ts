import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Prisma } from "@prisma/client";
// Already in the tree (fastify validates with it). Not declared in
// package.json yet: see the package's cross-package note.
import Ajv from "ajv";
import addFormats from "ajv-formats";

import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { AppError } from "@/shared/errors/AppError";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { buildPublicApiDocument, type OpenApiDocument } from "@/shared/integration/public-docs";

/**
 * What an error response carries, whatever the route declared — and that the
 * published document says exactly that (decision 11.3, DOCS-03/DOCS-11).
 *
 * Every refusal in the product leaves through ONE error handler, and every
 * route declares a response schema per status. Those schemas used to sit
 * between the two: the zod serializer validated each error body against the
 * route's own schema, so a schema that demanded `issues` turned a malformed
 * body into a 500 ("Response doesn't match the schema"), and a schema that
 * only listed `message` stripped `code` and `issues` in silence — the fields a
 * client is supposed to decide on and the list of what it got wrong.
 *
 * No database: every request below is refused before any handler runs, or
 * reaches one of the probe routes registered here.
 */
type App = Awaited<typeof import("@/http")>["app"];

let app: App;

/** Probe routes: each answers one branch of the error handler, for real. */
const PROBE = "/__error-contract";

beforeAll(async () => {
  ({ app } = await import("@/http"));

  // Before `ready()`, like every route of the product. Hidden from /docs.
  const hidden = { hide: true } as const;

  app.get(`${PROBE}/app-error`, { schema: hidden }, async () => {
    throw new AppError("Recusado.", 409, "SOMETHING_TAKEN");
  });

  app.get(`${PROBE}/crash`, { schema: hidden }, async () => {
    throw new Error("boom");
  });

  app.get(`${PROBE}/database-down`, { schema: hidden }, async () => {
    throw new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `localhost:5432`",
      "6.1.0",
      "P1001",
    );
  });

  app.get(`${PROBE}/busy`, { schema: hidden }, async () => {
    throw new ServiceBusyError("Ocupado.", "SERVICE_BUSY", 3);
  });

  // A controller that still answers by itself, through a route whose
  // response schema lists only `message`: what every legacy route looked like.
  app.get(
    `${PROBE}/inline-without-code`,
    { schema: { ...hidden, response: { 404: z.object({ message: z.string() }) } } },
    async (_request, reply) => reply.status(404).send({ message: "Não achei." }),
  );

  app.get(
    `${PROBE}/inline-with-details`,
    { schema: { ...hidden, response: { 409: z.object({ message: z.string() }) } } },
    async (_request, reply) =>
      reply.status(409).send({
        code: "ALREADY_DECIDED",
        message: "Já decidido.",
        decision: { status: "APPROVED" },
        // The route schema types the body as `{ message }`: that is the point.
      } as never),
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

describe("an error body leaves the handler intact", () => {
  it("answers malformed JSON on the public quote form with 400, not 500", async () => {
    // The 400 schema of this route demanded `issues`, which a parser error
    // does not have — so the serializer threw and the client read a 500.
    const response = await app.inject({
      method: "POST",
      url: "/quote/create-quote",
      headers: { "content-type": "application/json" },
      payload: '{"name": "sem fechar"',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MALFORMED_REQUEST");
  });

  it("keeps the list of refused fields on a validation error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/user/session",
      payload: { email: "x" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(response.json().issues)).toBe(true);
    expect(response.json().issues.length).toBeGreaterThan(0);
  });

  it("keeps the code on a route whose 400 schema only lists a message", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/forgot-verification",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("keeps the code on the public API's 401", async () => {
    // An integrator decides on `body.code`; the header is a convenience.
    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().code).toBe("INVALID_API_KEY");
    expect(response.headers["x-error-code"]).toBe("INVALID_API_KEY");
  });

  it("gives a code to a 4xx a controller sent without one", async () => {
    // Red before: `{ message }` went out alone, while the document promises
    // `code` on every refusal and the app's outbox classifies by it.
    const response = await app.inject({ method: "GET", url: `${PROBE}/inline-without-code` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND", message: "Não achei." });
    expect(response.headers["x-error-code"]).toBe("NOT_FOUND");
  });

  it("does not let a route's schema strip the code and the details of a 4xx", async () => {
    // Red before: the route's `{ message }` schema dropped `code` and the
    // `decision` the losing operator is told about.
    const response = await app.inject({ method: "GET", url: `${PROBE}/inline-with-details` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "ALREADY_DECIDED",
      message: "Já decidido.",
      decision: { status: "APPROVED" },
    });
    expect(response.headers["x-error-code"]).toBe("ALREADY_DECIDED");
  });
});

/**
 * The published error schemas, checked against the bodies the API REALLY
 * sends — captured from the handler above, never typed by hand — with a JSON
 * Schema validator that honours `additionalProperties: false` and `required`.
 *
 * A zod `safeParse` over the route's own schema passed while the published
 * JSON forbade `code`: it checked the wrong artefact, and loosely.
 */
describe("the published error schemas (strict)", () => {
  type Json = Record<string, any>;

  interface Captured {
    status: number;
    body: Json;
    headers: Record<string, unknown>;
  }

  const bodies: Record<string, Captured> = {};

  const capture = async (
    name: string,
    request: InjectOptions,
  ): Promise<void> => {
    const response: LightMyRequestResponse = await app.inject(request);

    bodies[name] = {
      status: response.statusCode,
      body: response.json(),
      headers: response.headers,
    };
  };

  beforeAll(async () => {
    await capture("validation", { method: "POST", url: "/user/session", payload: { email: "x" } });
    await capture("malformed", {
      method: "POST",
      url: "/quote/create-quote",
      headers: { "content-type": "application/json" },
      payload: '{"name": "sem fechar"',
    });
    await capture("appError", { method: "GET", url: `${PROBE}/app-error` });
    await capture("inline", { method: "GET", url: `${PROBE}/inline-without-code` });
    await capture("internal", { method: "GET", url: `${PROBE}/crash` });
    await capture("databaseDown", { method: "GET", url: `${PROBE}/database-down` });
    await capture("busy", { method: "GET", url: `${PROBE}/busy` });
    await capture("invalidKey", { method: "GET", url: "/integration/v1/deliveries" });
  });

  it("captured each branch of the handler with the status it is meant to have", () => {
    expect(bodies.validation.status).toBe(400);
    expect(bodies.malformed.status).toBe(400);
    expect(bodies.appError.status).toBe(409);
    expect(bodies.inline.status).toBe(404);
    expect(bodies.internal.status).toBe(500);
    expect(bodies.databaseDown.status).toBe(503);
    expect(bodies.busy.status).toBe(503);
    expect(bodies.invalidKey.status).toBe(401);

    // Every refusal carries a code; a 503 says when to come back.
    for (const captured of Object.values(bodies)) {
      expect(typeof captured.body.code).toBe("string");
    }
    expect(bodies.databaseDown.headers["retry-after"]).toBeDefined();
    expect(bodies.busy.headers["retry-after"]).toBeDefined();
  });

  /** The bodies a route can answer with on `status`, from the real ones. */
  function realBodiesFor(status: number, schema: Json): Json[] {
    const as4xx = (captured: Captured) => captured.body;

    if (status === 400) {
      return [bodies.validation.body, bodies.malformed.body, as4xx(bodies.appError), as4xx(bodies.inline)];
    }

    if (status === 500) return [bodies.internal.body];

    if (status === 503) {
      // The keyed routes can only be refused by the outage (enum); the
      // session routes also by a dependency's own 503.
      const onlyOutage = schema.properties?.code?.enum?.length === 1;

      return onlyOutage ? [bodies.databaseDown.body] : [bodies.databaseDown.body, bodies.busy.body];
    }

    if (status >= 400 && status < 500) {
      return [as4xx(bodies.appError), as4xx(bodies.inline), bodies.invalidKey.body];
    }

    return [];
  }

  /**
   * OpenAPI 3.0's `nullable` is not JSON Schema: written as the type it
   * means, so the validator reads the document as a client generator would.
   */
  function asJsonSchema(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(asJsonSchema);
    if (!node || typeof node !== "object") return node;

    const { nullable, ...rest } = node as Json;
    const converted = Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, asJsonSchema(value)]),
    );

    if (nullable !== true) return converted;

    return typeof converted.type === "string"
      ? { ...converted, type: [converted.type, "null"] }
      : { anyOf: [converted, { type: "null" }] };
  }

  function refusalsOf(document: Json): string[] {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);

    // The components the document refers to, so a $ref resolves.
    ajv.addSchema(asJsonSchema({ components: document.components ?? {} }) as Json, "doc");

    const refused: string[] = [];

    for (const [path, methods] of Object.entries<Json>(document.paths ?? {})) {
      for (const [method, operation] of Object.entries<Json>(methods)) {
        for (const [status, response] of Object.entries<Json>(operation.responses ?? {})) {
          const code = Number(status);

          if (!(code >= 400)) continue;

          const schema = response.content?.["application/json"]?.schema;

          if (!schema) {
            refused.push(`${method.toUpperCase()} ${path} → ${status}: sem corpo JSON publicado`);
            continue;
          }

          // A route-built 503 (the readiness probe) has its own body.
          if (code === 503 && !schema.properties?.code) continue;

          const validate = ajv.compile(
            asJsonSchema(
              JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"doc#/components/')),
            ) as Json,
          );

          const accepts = validate as (data: unknown) => boolean;

          for (const body of realBodiesFor(code, schema)) {
            if (!accepts(body)) {
              refused.push(
                `${method.toUpperCase()} ${path} → ${status} ${body.code}: ${ajv.errorsText(validate.errors)}`,
              );
            }
          }
        }
      }
    }

    return refused;
  }

  it("accept every body the handler really sends, in /docs", () => {
    expect(refusalsOf(app.swagger() as Json)).toEqual([]);
  });

  it("accept every body the handler really sends, in the public reference", () => {
    const document = buildPublicApiDocument(app.swagger() as OpenApiDocument) as Json;

    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
    expect(refusalsOf(document)).toEqual([]);
  });

  it("refuse a body the handler never sends (the check has teeth)", () => {
    // Self-test: a 500 without `requestId`, or a 4xx carrying a field no
    // schema lists, must fail — else the two checks above prove nothing.
    const document = app.swagger() as Json;
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);

    const operation = document.paths["/fuel/create-fuel/{businessId}"].post;
    const internal = ajv.compile(operation.responses["500"].content["application/json"].schema);
    const notFound = ajv.compile(operation.responses["404"].content["application/json"].schema);

    expect(internal({ code: "INTERNAL_ERROR", status: "error", message: "x" })).toBe(false);
    expect(notFound({ code: "X", message: "m", stack: "at ..." })).toBe(false);
    expect(notFound({ message: "sem código" })).toBe(false);
  });

  it("send the error code in a header wherever the body has one (4xx)", () => {
    const document = app.swagger() as Json;
    const missing: string[] = [];

    for (const [path, methods] of Object.entries<Json>(document.paths)) {
      for (const [method, operation] of Object.entries<Json>(methods)) {
        for (const [status, response] of Object.entries<Json>(operation.responses ?? {})) {
          const code = Number(status);

          if (code >= 400 && code < 500 && !response.headers?.["x-error-code"]) {
            missing.push(`${method.toUpperCase()} ${path} → ${status}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe("the success fields the controllers send", () => {
  type JsonSchema = { properties?: Record<string, JsonSchema> };

  const successSchema = (path: string, method: string, status: string) => {
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              { content?: { "application/json"?: { schema?: JsonSchema } } }
            >;
          }
        >
      >;
    };

    return document.paths[path]?.[method]?.responses[status]?.content?.[
      "application/json"
    ]?.schema;
  };

  it("publishes the id of a new fueling", () => {
    // The app's outbox records the id of what it created; a schema without
    // it strips the field on the way out.
    const schema = successSchema("/fuel/create-fuel/{businessId}", "post", "201");

    expect(Object.keys(schema?.properties ?? {})).toContain("id");
  });

  it("publishes the id of a new checklist", () => {
    const schema = successSchema(
      "/vehicle-checklist/create-vehicle-checklist/{businessId}",
      "post",
      "201",
    );

    expect(Object.keys(schema?.properties ?? {})).toContain("id");
  });

  it("publishes the id of the row a webhook resend created", () => {
    const schema = successSchema(
      "/integrations/webhook-delivery/{id}/business/{businessId}/resend",
      "post",
      "200",
    );

    expect(Object.keys(schema?.properties?.data?.properties ?? {})).toContain(
      "id",
    );
  });
});
