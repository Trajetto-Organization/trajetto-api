import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  findUnstorableText,
  isUnstorable,
  rejectUnstorableText,
} from "@/shared/http/unstorable-text";

/**
 * NUL and lone surrogates pass every zod rule and crash the query engine:
 * a 500 at error level on any create, rename or list search (security pass
 * 10/2026). The guard finds them anywhere in params, query and body.
 */
describe("isUnstorable", () => {
  it("flags NUL and lone surrogates, and nothing a person types", () => {
    expect(isUnstorable("Emb\u0000arcador")).toBe(true);
    expect(isUnstorable("Emb\ud800arcador")).toBe(true);
    expect(isUnstorable("\udc00 sozinho")).toBe(true);

    expect(isUnstorable("Ação, coração — 😀 ñ")).toBe(false);
    expect(isUnstorable("linha\nnova\ttab")).toBe(false);
    expect(isUnstorable("")).toBe(false);
  });
});

describe("findUnstorableText", () => {
  it("names the field, inside objects and arrays", () => {
    expect(
      findUnstorableText({ name: "ok", items: [{ description: "a\u0000b" }] }),
    ).toEqual(["items", 0, "description"]);
  });

  it("checks keys too", () => {
    expect(findUnstorableText({ ["ch\u0000ave"]: 1 })).toEqual(["ch\u0000ave"]);
  });

  it("passes clean values, numbers, nulls and buffers", () => {
    expect(
      findUnstorableText({ a: 1, b: null, c: true, d: ["x", { e: "y" }] }),
    ).toBeNull();
    expect(findUnstorableText(Buffer.from([0, 0, 0]))).toBeNull();
    expect(findUnstorableText(undefined)).toBeNull();
  });

  it("stays linear on a body nested 200 000 deep", () => {
    // The first version copied the path at every level: O(depth²), minutes of
    // a frozen event loop for one 400 kB request.
    let deep: unknown = "a\u0000b";
    for (let level = 0; level < 200_000; level += 1) deep = [deep];

    const started = performance.now();
    const path = findUnstorableText({ a: deep });
    const elapsed = performance.now() - started;

    expect(path?.[0]).toBe("a");
    expect(path!.length).toBeLessThanOrEqual(16);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("rejectUnstorableText", () => {
  const request = (where: {
    params?: unknown;
    query?: unknown;
    body?: unknown;
  }) => ({ params: {}, query: {}, body: undefined, ...where }) as never;

  it("refuses with a validation error naming where it was found", async () => {
    const error = await rejectUnstorableText(
      request({ query: { search: "a\u0000b" } }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]).toMatchObject({
      path: ["query", "search"],
      message: "O texto enviado contém um caractere inválido.",
    });
  });

  it("lets a clean request through", async () => {
    await expect(
      rejectUnstorableText(
        request({ params: { id: "x" }, body: { name: "Ação" } }),
      ),
    ).resolves.toBeUndefined();
  });
});
