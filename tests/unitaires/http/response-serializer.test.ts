import fastify from "fastify";
import { validatorCompiler } from "fastify-type-provider-zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { errorAwareSerializerCompiler } from "@/shared/errors/error-body";
import { parsingSerializerCompiler } from "@/shared/http/response-serializer";

/**
 * A success body is PARSED by its route's schema, as with zod 3.
 *
 * fastify-type-provider-zod 7's own serializer encodes instead: no default
 * filled, and a transform or a preprocess cannot run in reverse, so a body
 * the API sends today would become a 500.
 */
const body = z.object({
  message: z.string().default("Criado com sucesso."),
  id: z.string(),
  at: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string(),
  ),
});

function appSending(data: unknown) {
  const app = fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(
    errorAwareSerializerCompiler(parsingSerializerCompiler),
  );
  app.get("/thing", { schema: { response: { 200: body } } }, async () => data);

  return app;
}

describe("the response serializer", () => {
  it("fills a default, runs a preprocess and strips what the schema does not name", async () => {
    const app = appSending({
      id: "a1",
      at: new Date("2026-11-10T12:00:00.000Z"),
      password: "nunca sai",
    });

    const response = await app.inject({ method: "GET", url: "/thing" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: "Criado com sucesso.",
      id: "a1",
      at: "2026-11-10T12:00:00.000Z",
    });
  });

  it("refuses a body that breaks its schema, as before", async () => {
    const app = appSending({ at: "2026-11-10" });

    const response = await app.inject({ method: "GET", url: "/thing" });

    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("FST_ERR_RESPONSE_SERIALIZATION");
  });
});
