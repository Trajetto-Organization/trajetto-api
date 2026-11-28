import { PerformanceObserver } from "node:perf_hooks";

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

  /**
   * A body nested `depth` arrays deep around a NUL, every level behind a
   * counter of what the walk asks of it (each property read, key listing,
   * prototype lookup): the walk's cost in operations, the same on any
   * machine. It used to be a 2 s wall-clock budget on the 200 000-deep body,
   * the kind a full parallel run breaks with nothing wrong in the code
   * (docs/testes.md). What these counts hold is the walk itself: no
   * recursion, and each level visited once, never again for every level
   * below it. The first version's O(depth²) was elsewhere: it copied the
   * path at every level (minutes of a frozen event loop for one 400 kB
   * request), and that copy reads nothing of the body, so no counter here
   * sees it. The allocation test below covers it.
   */
  const OPERATIONS_PER_LEVEL = 8;

  function nestedBody(depth: number) {
    const budget = OPERATIONS_PER_LEVEL * depth;
    let operations = 0;
    // One handler for every trap: count it, then answer as the array would.
    const counter = new Proxy({} as ProxyHandler<unknown[]>, {
      get:
        (_handler, trap) =>
        (...args: unknown[]) => {
          operations += 1;
          // A walk that goes back over the levels above stops here, with the
          // count, instead of holding the test (synchronous, so no timeout
          // can cut it) for minutes.
          if (operations > budget) {
            throw new Error(`over ${budget} operations for ${depth} levels`);
          }

          return (
            Reflect[trap as keyof typeof Reflect] as (
              ...forwarded: unknown[]
            ) => unknown
          )(...args);
        },
    });

    let deep: unknown = "a\u0000b";
    for (let level = 0; level < depth; level += 1) {
      deep = new Proxy([deep], counter);
    }

    return { path: findUnstorableText({ a: deep }), operations };
  }

  it("walks a body nested 200 000 deep, without recursion and a few operations per level", () => {
    // A recursive walk runs out of stack (RangeError) a few thousand levels
    // down. 4 operations per level today: the prototype, the length twice,
    // the item.
    const { path, operations } = nestedBody(200_000);

    expect(path?.[0]).toBe("a");
    expect(path!.length).toBeLessThanOrEqual(16);
    expect(operations).toBeLessThanOrEqual(OPERATIONS_PER_LEVEL * 200_000);
  });

  it("costs twice the operations for twice the depth", () => {
    const shallow = nestedBody(2_000);
    const deeper = nestedBody(4_000);

    // Linear: exactly twice today. A walk that reads the levels above again
    // for every level made it 4 times; the path copy of the first version
    // reads nothing of the body (same count), and the allocation test
    // covers it.
    expect(deeper.operations).toBeLessThanOrEqual(2.5 * shallow.operations);
  });

  /**
   * How many garbage collections run while the walk goes through a plain
   * body nested `depth` arrays deep around a NUL. Each one is the engine
   * taking back memory the walk allocated, so the count follows what the
   * code allocates, not how busy the machine is (no clock involved). The
   * body is built before the count starts.
   */
  async function collectionsWhileWalking(depth: number) {
    let deep: unknown = "a\u0000b";
    for (let level = 0; level < depth; level += 1) deep = [deep];

    // One turn of the event loop: whatever the engine still had to do after
    // building the body runs here, outside the count.
    await new Promise((resolve) => setImmediate(resolve));

    let collections = 0;
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length;
    });
    observer.observe({ entryTypes: ["gc"] });

    const path = findUnstorableText({ a: deep });

    // Node hands the entries over on a later turn; takeRecords() picks up
    // the ones not yet passed to the callback.
    await new Promise((resolve) => setImmediate(resolve));
    collections += observer.takeRecords().length;
    observer.disconnect();

    return { path, collections };
  }

  it("builds the path once, for the culprit, never a copy per level", async () => {
    const { path, collections } = await collectionsWhileWalking(20_000);

    // The walk did reach the NUL at the bottom.
    expect(path?.[0]).toBe("a");
    // A path copied at every level allocates O(depth²): about 1.6 GB here,
    // some 260 collections. Parent links and a path built only for the
    // culprit allocate a few bytes per level: at most 1 today, after the
    // tests above.
    expect(collections).toBeLessThanOrEqual(20);
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
