import fastify from "fastify";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The API's JSON body parser, and the prototype-poisoning guard it dropped.
 *
 * Fastify's default parser runs `secure-json-parse` and answers 400 to a body
 * carrying `__proto__` or `constructor.prototype`. The custom parser that was
 * installed to tolerate an EMPTY JSON body (DELETE from the web) replaced it
 * with a bare `JSON.parse`, which accepts both. Zod strips the key today, so
 * nothing is exploitable yet — but one route without a body schema, or one
 * `Object.assign(target, request.body)`, and the key becomes prototype
 * pollution. The guard is a layer that must stay on.
 */

const POISONED_PROTO = '{"__proto__":{"role":"MASTER"}}';
const POISONED_CONSTRUCTOR = '{"constructor":{"prototype":{"role":"MASTER"}}}';

describe("tolerateEmptyJsonBody over Fastify's default parser", () => {
  const app = fastify();

  beforeAll(async () => {
    const { tolerateEmptyJsonBody } = await import(
      "@/shared/http/json-body-parser"
    );

    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      tolerateEmptyJsonBody(app.getDefaultJsonParser("error", "error")),
    );

    app.post("/echo", async (request) => ({ body: request.body ?? null }));
    app.delete("/echo", async (request) => ({ body: request.body ?? null }));

    await app.ready();
  });

  afterAll(() => app.close());

  const send = (payload: string, method: "POST" | "DELETE" = "POST") =>
    app.inject({
      method,
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload,
    });

  it("refuses a body that carries __proto__", async () => {
    const response = await send(POISONED_PROTO);

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/prototype/i);
  });

  it("refuses a body that carries constructor.prototype", async () => {
    const response = await send(POISONED_CONSTRUCTOR);

    expect(response.statusCode).toBe(400);
  });

  it("still accepts an empty body as undefined", async () => {
    const response = await send("", "DELETE");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: null });
  });

  it("still accepts a whitespace-only body as undefined", async () => {
    const response = await send("  \n ", "DELETE");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: null });
  });

  it("parses ordinary JSON", async () => {
    const response = await send('{"a":1}');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { a: 1 } });
  });

  it("refuses malformed JSON with a 400", async () => {
    const response = await send("{bad");

    expect(response.statusCode).toBe(400);
  });
});

describe("the API itself", () => {
  let app: Awaited<typeof import("@/http")>["app"];

  beforeAll(async () => {
    ({ app } = await import("@/http"));
    await app.ready();
  }, APP_BOOT_TIMEOUT_MS);

  afterAll(() => app.close());

  it.each([
    ["__proto__", POISONED_PROTO],
    ["constructor.prototype", POISONED_CONSTRUCTOR],
  ])(
    "refuses a %s body at the parser, before any route sees it",
    async (_label, payload) => {
      // A public route with a body schema: before the fix the poisoned key was
      // parsed, handed to zod and only then refused as a plain validation
      // error. The parser now stops it first and names the reason.
      const response = await app.inject({
        method: "POST",
        url: "/quote/create-quote",
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("MALFORMED_REQUEST");
    },
  );
});
