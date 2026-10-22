import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { sendAsNDJSON } from "@/config/stream-utils";
import { cursorMeta, offsetMeta } from "@/routes/documentation/ndjson";

import { deepStrict } from "./support/deep-strict";

import {
  introspectRoutes,
  type IntrospectedRoute,
  type OpenApiOperation,
} from "./support/introspect-routes";

/**
 * The listings that answer one JSON document per line.
 *
 * Half the listing routes stream NDJSON and the document described every one
 * of them as `application/json`, with envelopes (`{ data, total }`) or
 * placeholders (`{ description }`) that are never sent, and a cursor meta
 * (`meta.nextCursor`) that is really `meta.searchMeta.nextCursor`. A client
 * built from /docs either fails to parse the body or stops paging after the
 * first page.
 *
 * Which routes stream is read from their handlers, not from a list: a new
 * listing that streams is checked the day it is added.
 */
type Published = IntrospectedRoute & { operation: OpenApiOperation };

let streaming: Published[] = [];
let close: () => Promise<void>;

const NDJSON = "application/x-ndjson";

function handlerText(route: IntrospectedRoute): string {
  return String(route.handler);
}

beforeAll(async () => {
  const introspected = await introspectRoutes();

  close = introspected.close;

  streaming = introspected.routes.filter(
    (route): route is Published =>
      !route.hidden &&
      route.operation !== undefined &&
      handlerText(route).includes("sendAsNDJSON"),
  );
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("every listing that streams NDJSON", () => {
  it("is found by its handler, so nothing below passes vacuously", () => {
    expect(streaming.length).toBeGreaterThanOrEqual(49);
  });

  it("publishes its 200 as application/x-ndjson, never as JSON", () => {
    const wrong = streaming
      .filter((route) => {
        const content = route.operation.responses["200"]?.content ?? {};

        return !content[NDJSON] || "application/json" in content;
      })
      .map(({ id }) => id);

    expect(wrong).toEqual([]);
  });

  it("describes the meta line and a real item, not an envelope", () => {
    const wrong: string[] = [];

    for (const route of streaming) {
      const schema = route.operation.responses["200"]?.content?.[NDJSON]
        ?.schema as { oneOf?: Array<{ properties?: Record<string, unknown> }> };

      const [meta, item] = schema?.oneOf ?? [];

      const itemKeys = Object.keys(item?.properties ?? {});

      if (
        !meta?.properties?.meta ||
        itemKeys.length < 2 ||
        // The envelope the stream never sends.
        (itemKeys.includes("data") && itemKeys.includes("total"))
      ) {
        wrong.push(route.id);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("never claims a line carries only the fields it lists", () => {
    // A JSON body is cut down to its schema by the serializer, so
    // `additionalProperties: false` is true there. A stream is not: most
    // listings select the whole row, and a validator built from /docs would
    // reject every real line that carries a column the item does not name.
    const closed = (schema: unknown, path: string, found: string[]): void => {
      if (!schema || typeof schema !== "object") return;

      const node = schema as Record<string, unknown>;

      if (node.additionalProperties === false) found.push(path || "(item)");

      for (const [name, child] of Object.entries(
        (node.properties ?? {}) as Record<string, unknown>,
      )) {
        closed(child, `${path}.${name}`, found);
      }

      closed(node.items, `${path}[]`, found);

      for (const combinator of ["anyOf", "oneOf", "allOf"]) {
        for (const member of (node[combinator] ?? []) as unknown[]) {
          closed(member, path, found);
        }
      }
    };

    const found: string[] = [];

    for (const route of streaming) {
      const schema = route.operation.responses["200"]?.content?.[NDJSON]
        ?.schema as { oneOf?: unknown[] };

      closed(schema?.oneOf?.[1], route.id, found);
    }

    expect(found).toEqual([]);
  });

  it("tells a cursor client where the next cursor really is", () => {
    const cursorRoutes = streaming.filter((route) =>
      handlerText(route).includes("nextCursor"),
    );

    expect(cursorRoutes.length).toBeGreaterThanOrEqual(18);

    const wrong = cursorRoutes
      .filter((route) => {
        const published = JSON.stringify(route.operation.responses["200"]);
        const description = route.operation.description ?? "";

        return (
          !published.includes("searchMeta") ||
          !published.includes("nextCursor") ||
          !published.includes("hasMore") ||
          // The sentence that sent clients to `meta.nextCursor`.
          description.includes("{meta: {nextCursor")
        );
      })
      .map(({ id }) => id);

    expect(wrong).toEqual([]);
  });
});

/**
 * What the documented meta line is checked against: the bytes sendAsNDJSON
 * really writes, for both kinds of listing.
 */
async function firstLine(
  result: Parameters<typeof sendAsNDJSON>[0]["dataPromise"] extends Promise<
    infer R
  >
    ? R
    : never,
  pagination: { page?: number; pageSize?: number } = {},
) {
  const headers: Record<string, string> = {};
  let payload: AsyncIterable<unknown> | undefined;

  const reply = {
    request: { headers: {} },
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    send(body: AsyncIterable<unknown>) {
      payload = body;
      return reply;
    },
  };

  await sendAsNDJSON({
    reply: reply as never,
    dataPromise: Promise.resolve(result),
    ...pagination,
  });

  let text = "";

  for await (const chunk of payload!) text += String(chunk);

  return {
    contentType: headers["content-type"],
    meta: JSON.parse(text.split("\n")[0]).meta as Record<string, unknown>,
  };
}

describe("the documented meta line", () => {
  it("is what a cursor listing really sends", async () => {
    const { contentType, meta } = await firstLine({
      data: [{ id: "a" }],
      total: 0,
      meta: { nextCursor: "a", hasMore: true },
    });

    expect(contentType).toBe(NDJSON);
    expect(deepStrict(cursorMeta()).safeParse(meta).success).toBe(true);

    // Where the old description told clients to look.
    expect(meta.nextCursor).toBeUndefined();
  });

  it("is what an offset listing really sends", async () => {
    const { meta } = await firstLine(
      { data: [{ id: "a" }], total: 41 },
      { page: 3, pageSize: 20 },
    );

    expect(deepStrict(offsetMeta).safeParse(meta).success).toBe(true);
    expect(meta).toEqual({ total: 41, page: 3, pageSize: 20 });
  });
});
