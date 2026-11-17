import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";
import { listPagesSchema } from "@/schemas/list-pages-schema";
import {
  isTooDeep,
  listOffsetTooDeep,
  rejectDeepListOffset,
} from "@/shared/pagination/offset-ceiling";

/**
 * The offset ceiling of the panel's listings (plano-escala F2-30, decision
 * D42).
 *
 * Page 5,000 of the deliveries makes Postgres read, sort and drop 49,990
 * rows to answer ten. Nobody reads that far by turning pages: past 10,000
 * rows the listing answers 400 LIST_OFFSET_TOO_DEEP with what to do
 * instead (filter or export), and the web stops its pager at the same row.
 * Checked once for every route, after validation, on the numbers the
 * `page` and `pageSize` fields produce; LIST_MAX_OFFSET=0 turns it off.
 */

const saved = env.LIST_MAX_OFFSET;

afterEach(() => {
  env.LIST_MAX_OFFSET = saved;
});

describe("the ceiling", () => {
  it("lets the page that ends at row 10,000 through and refuses the next", () => {
    expect(isTooDeep(1_000, 10, 10_000)).toBe(false);
    expect(isTooDeep(1_001, 10, 10_000)).toBe(true);
    expect(isTooDeep(200, 50, 10_000)).toBe(false);
    expect(isTooDeep(201, 50, 10_000)).toBe(true);
    expect(isTooDeep(1, 100, 10_000)).toBe(false);
  });

  it("is off at 0", () => {
    expect(isTooDeep(1_000_000, 100, 0)).toBe(false);
  });

  it("says what to do instead, with a stable code", () => {
    const refusal = listOffsetTooDeep(10_000);

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal.statusCode).toBe(400);
    expect(refusal.code).toBe("LIST_OFFSET_TOO_DEEP");
    expect(refusal.message).toBe(
      "A lista vai até a linha 10.000. Para ver além, use um filtro (o período, o status ou a busca) ou a exportação.",
    );
  });
});

describe("the hook, after validation", () => {
  async function appWith(maxOffset: number) {
    env.LIST_MAX_OFFSET = maxOffset;

    const app = fastify().withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook("preHandler", rejectDeepListOffset);
    app.setErrorHandler((error, _request, reply) =>
      reply
        .status((error as AppError).statusCode ?? 500)
        .send({ code: (error as AppError).code }),
    );

    app.get(
      "/list",
      { schema: { querystring: listPagesSchema } },
      async () => ({ ok: true }),
    );
    app.get(
      "/raw",
      { schema: { querystring: z.object({ page: z.string().optional() }) } },
      async () => ({ ok: true }),
    );

    await app.ready();

    return app;
  }

  it("refuses a listing past the ceiling, and serves the last page under it", async () => {
    const app = await appWith(10_000);

    try {
      expect(
        (await app.inject({ url: "/list?page=1000&pageSize=10" })).statusCode,
      ).toBe(200);

      const refused = await app.inject({ url: "/list?page=1001&pageSize=10" });

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ code: "LIST_OFFSET_TOO_DEEP" });
    } finally {
      await app.close();
    }
  });

  it("leaves a route alone when its page is not a validated number", async () => {
    const app = await appWith(10_000);

    try {
      expect((await app.inject({ url: "/raw?page=999999" })).statusCode).toBe(
        200,
      );
    } finally {
      await app.close();
    }
  });

  it("serves every page with the ceiling off", async () => {
    const app = await appWith(0);

    try {
      expect(
        (await app.inject({ url: "/list?page=999999&pageSize=100" }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
