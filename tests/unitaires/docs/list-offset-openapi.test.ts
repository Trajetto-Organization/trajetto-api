import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The lists' new answers, as the document lists them (plano-escala F2-30).
 *
 * The ceiling refuses any offset listing past row 10,000 (400
 * LIST_OFFSET_TOO_DEEP), and the deliveries listing takes `facets=skip`.
 * A client generated from /docs must see both: the ceiling on every route
 * that pages by `page` and `pageSize`, never on one that does not.
 */
type Json = Record<string, any>;

let app: Awaited<typeof import("@/http")>["app"];
let document: Json;

beforeAll(async () => {
  ({ app } = await import("@/http"));

  await app.ready();

  document = app.swagger() as Json;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const operations = () =>
  Object.entries<Json>(document.paths ?? {}).flatMap(([route, methods]) =>
    Object.entries<Json>(methods).map(([method, op]) => ({
      id: `${method.toUpperCase()} ${route}`,
      op,
    })),
  );

const pagesByOffset = (op: Json) => {
  const names = new Set(
    (op.parameters ?? [])
      .filter((parameter: Json) => parameter.in === "query")
      .map((parameter: Json) => parameter.name),
  );

  return names.has("page") && names.has("pageSize");
};

const badRequestText = (op: Json) =>
  JSON.stringify(op.responses?.["400"] ?? {});

/**
 * The listings that cap their own pages and answer their own code
 * (`config.ownOffsetCeiling`): the global hook leaves them alone, so their
 * document shows that code instead. A closed list: a new entry is a
 * decision.
 */
const OWN_CEILINGS: Record<string, string> = {
  "GET /integrations/webhook-deliveries": "MONITOR_PAGE_OUT_OF_RANGE",
};

describe("LIST_OFFSET_TOO_DEEP", () => {
  it("is documented on every route that pages by offset", () => {
    const listings = operations().filter(({ op }) => pagesByOffset(op));

    expect(listings.length).toBeGreaterThan(20);

    const missing = listings
      .filter(
        ({ id, op }) =>
          !badRequestText(op).includes(
            OWN_CEILINGS[id] ?? "LIST_OFFSET_TOO_DEEP",
          ),
      )
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  it("is never documented on a route that does not", () => {
    const stray = operations()
      .filter(({ id, op }) => !pagesByOffset(op) || id in OWN_CEILINGS)
      .filter(({ op }) => badRequestText(op).includes("LIST_OFFSET_TOO_DEEP"))
      .map(({ id }) => id);

    expect(stray).toEqual([]);
  });

  it("knows every route with its own ceiling", () => {
    for (const id of Object.keys(OWN_CEILINGS)) {
      const op = operations().find((operation) => operation.id === id)?.op;

      expect(op && pagesByOffset(op), id).toBe(true);
    }
  });
});

describe("facets=skip", () => {
  it("is a documented parameter of the deliveries listing", () => {
    const list = document.paths["/delivery/list-delivery"].get;
    const facets = (list.parameters as Json[]).find(
      (parameter) => parameter.in === "query" && parameter.name === "facets",
    );

    expect(facets?.schema?.enum).toEqual(["skip"]);
    expect(facets?.description).toContain("sem contar nada");
  });
});
