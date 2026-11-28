import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { validatorCompiler } from "fastify-type-provider-zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  snapshotEtag,
  type TenantSnapshotRead,
} from "@/shared/cache/tenant-snapshot";
import {
  completeErrorBody,
  errorAwareSerializerCompiler,
} from "@/shared/errors/error-body";
import { parsingSerializerCompiler } from "@/shared/http/response-serializer";
import {
  SNAPSHOT_CACHE_CONTROL,
  ageOf,
  sendSnapshot,
  successBodyOf,
  wantsFreshSnapshot,
} from "@/shared/http/snapshot-reply";

/**
 * The HTTP side of the tower's snapshot (plano-escala F4-11). A copy is a
 * body the route serialized once and every operator of the company then
 * receives, so it must be byte for byte what reply.send writes for the
 * value — the schema parses it, which strips, fills defaults and puts the
 * keys in the schema's order — and carry what lets a client skip it: the
 * ETag, the 304 and the age. With the snapshot off, nothing new leaves.
 */
const schema = z.object({
  data: z.object({
    zone: z.string(),
    count: z.number(),
    note: z.string().default("sem nota"),
  }),
});

/** A value whose keys come in another order, with a field the schema drops. */
const value = {
  data: { count: 3, secret: "nunca sai", zone: "America/Sao_Paulo" },
};

function appWith(
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
) {
  const app = fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(
    errorAwareSerializerCompiler(parsingSerializerCompiler),
  );
  app.addHook("preSerialization", completeErrorBody);
  app.get(
    "/plain",
    { schema: { response: { 200: schema } } },
    async () => value,
  );
  app.get("/snap", { schema: { response: { 200: schema } } }, handler);

  return app;
}

function readOf(body: string, overrides: Partial<TenantSnapshotRead> = {}) {
  return {
    body,
    etag: snapshotEtag(body),
    at: Date.now(),
    source: "copy",
    ...overrides,
  } satisfies TenantSnapshotRead;
}

describe("the body a snapshot keeps", () => {
  it("is byte for byte what the route sends for the value, with the same content type", async () => {
    let kept = "";
    const app = appWith(async (request, reply) => {
      kept = successBodyOf(reply)(value);

      return sendSnapshot(request, reply, readOf(kept));
    });

    const plain = await app.inject({ method: "GET", url: "/plain" });
    const snap = await app.inject({ method: "GET", url: "/snap" });

    expect(kept).toBe(
      '{"data":{"zone":"America/Sao_Paulo","count":3,"note":"sem nota"}}',
    );
    expect(snap.statusCode).toBe(200);
    expect(snap.body).toBe(plain.body);
    expect(snap.headers["content-type"]).toBe(plain.headers["content-type"]);
  });

  it("is refused as the route would refuse it, when the value breaks the schema", async () => {
    const app = appWith(async (request, reply) => {
      const body = successBodyOf(reply)({ data: { zone: 1 } });

      return sendSnapshot(request, reply, readOf(body));
    });

    const response = await app.inject({ method: "GET", url: "/snap" });

    expect(response.statusCode).toBe(500);
  });
});

describe("the answer from a snapshot", () => {
  const body = '{"data":{"zone":"America/Sao_Paulo","count":3,"note":"x"}}';

  it("carries the ETag, the age of the copy and a private no-cache", async () => {
    const app = appWith(async (request, reply) =>
      sendSnapshot(request, reply, readOf(body, { at: Date.now() - 7_400 })),
    );

    const response = await app.inject({ method: "GET", url: "/snap" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers.etag).toBe(snapshotEtag(body));
    expect(response.headers.age).toBe("7");
    expect(response.headers["cache-control"]).toBe(SNAPSHOT_CACHE_CONTROL);
  });

  it("answers 304 without a body to a client that holds the copy, weak or listed", async () => {
    const etag = snapshotEtag(body);
    const app = appWith(async (request, reply) =>
      sendSnapshot(request, reply, readOf(body)),
    );

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = await app.inject({
        method: "GET",
        url: "/snap",
        headers: { "if-none-match": header },
      });

      expect(response.statusCode, header).toBe(304);
      expect(response.body, header).toBe("");
      expect(response.headers.etag, header).toBe(etag);
      expect(response.headers["cache-control"], header).toBe(
        SNAPSHOT_CACHE_CONTROL,
      );
    }
  });

  it("answers 200 with the body to a client that holds another one", async () => {
    const app = appWith(async (request, reply) =>
      sendSnapshot(request, reply, readOf(body)),
    );

    const response = await app.inject({
      method: "GET",
      url: "/snap",
      headers: { "if-none-match": snapshotEtag("{}") },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
  });

  it("sends nothing new when the snapshot was off: no ETag, no age, no 304", async () => {
    const app = appWith(async (request, reply) =>
      sendSnapshot(request, reply, readOf(body, { source: "off" })),
    );

    const response = await app.inject({
      method: "GET",
      url: "/snap",
      headers: { "if-none-match": "*" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers.age).toBeUndefined();
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("counts the age in whole seconds, never below zero", () => {
    const read = readOf(body, { at: 10_000 });

    expect(ageOf(read, 10_000)).toBe(0);
    expect(ageOf(read, 19_999)).toBe(9);
    expect(ageOf(read, 9_000)).toBe(0);
  });
});

describe("the refresh hint", () => {
  it("is x-trajetto-refresh: 1, and nothing else", async () => {
    const seen: boolean[] = [];
    const app = appWith(async (request, reply) => {
      seen.push(wantsFreshSnapshot(request));

      return sendSnapshot(request, reply, readOf("{}"));
    });

    for (const header of ["1", "0", "true", ""]) {
      await app.inject({
        method: "GET",
        url: "/snap",
        headers: { "x-trajetto-refresh": header },
      });
    }

    await app.inject({ method: "GET", url: "/snap" });

    expect(seen).toEqual([true, false, false, false, false]);
  });
});
