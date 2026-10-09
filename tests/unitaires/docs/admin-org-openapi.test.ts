import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The published contract of the Kanban and company routes, read back out of
 * the running application (decision 11.4: /docs in pt-BR).
 *
 * Their summaries were English ("List kanban board", "Search businesses
 * (cursor-based)") while the behaviour behind them changed: a foreign column
 * or card is now a 404 with a code, the MASTER cannot assign another
 * company's user, a card delete can answer 409. The document has to say so.
 */
interface OpenApiOperation {
  summary?: string;
  description?: string;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

let document: OpenApiDocument;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as OpenApiDocument;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function operationsUnder(prefix: string): Array<[string, OpenApiOperation]> {
  return Object.entries(document.paths)
    .filter(([path]) => path.startsWith(prefix))
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, operation]) =>
          [`${method.toUpperCase()} ${path}`, operation] as [string, OpenApiOperation],
      ),
    );
}

/**
 * Words that give an English summary away. None is Portuguese: "a" and
 * "card" are left out on purpose (the article; the loanword the UI uses).
 */
const ENGLISH =
  /(?<!\p{L})(the|for|with|and|of|an|get|list|create|update|delete|search|toggle|request|confirm|reorder|business(es)?|board|column)(?!\p{L})/iu;

describe.each(["/kanban/", "/business/"])("%s in pt-BR", (prefix) => {
  it("summarises and describes every operation in Portuguese", () => {
    const operations = operationsUnder(prefix);

    expect(operations.length).toBeGreaterThan(5);

    const english = operations
      .filter(([, operation]) => ENGLISH.test(operation.summary ?? ""))
      .map(([name, operation]) => `${name}: ${operation.summary}`);

    expect(english, "resumo em inglês no /docs").toEqual([]);

    for (const [name, operation] of operations) {
      expect(operation.summary, name).toBeTruthy();
      expect((operation.description ?? "").length, name).toBeGreaterThan(40);
    }
  });
});

describe("the Kanban refusals are documented as the API answers them", () => {
  const schemaOf = (path: string, method: string, status: string) =>
    JSON.stringify(document.paths[path]?.[method]?.responses?.[status] ?? null);

  it("documents the 404 with its code on every write that takes an id", () => {
    const writes: Array<[string, string]> = [
      ["/kanban/column/update/{columnId}/business/{businessId}", "patch"],
      ["/kanban/column/delete/{columnId}/business/{businessId}", "delete"],
      ["/kanban/columns/reorder", "post"],
      ["/kanban/card/create", "post"],
      ["/kanban/card/update/{cardId}", "patch"],
      ["/kanban/card/delete/{cardId}", "delete"],
      ["/kanban/cards/reorder", "post"],
    ];

    for (const [path, method] of writes) {
      const notFound = schemaOf(path, method, "404");

      expect(notFound, `${method} ${path}`).toContain("code");
      expect(notFound, `${method} ${path}`).toMatch(/KANBAN_(COLUMN|CARD)_NOT_FOUND/);
      expect(document.paths[path][method].description, `${method} ${path}`).toContain(
        "outra empresa",
      );
    }
  });

  it("documents the 409 of a card write racing a move", () => {
    expect(schemaOf("/kanban/card/delete/{cardId}", "delete", "409")).toContain(
      "KANBAN_BOARD_CHANGED",
    );
    expect(schemaOf("/kanban/cards/reorder", "post", "409")).toContain("KANBAN_BOARD_CHANGED");
  });
});
