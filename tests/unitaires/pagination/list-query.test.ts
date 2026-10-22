import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MAX_FACET_VALUES,
  facetField,
  idFacetField,
  resolveOrderBy,
  sortFields,
  type SortSpec,
} from "@/shared/pagination/list-query";

import { sumCounts } from "@/shared/pagination/list-meta";

/**
 * The list contract's parsing rules (decision 8.8): what a listing accepts
 * as `sort`, `order` and facet params, and the order it turns them into.
 */
const schema = z.object({
  ...sortFields(["created_at", "name"] as const, {
    sort: "created_at",
    order: "desc",
  }),
  status: facetField(["OPEN", "CLOSED"] as const, "Status."),
  typeId: idFacetField("Tipos."),
});

const ID_A = "018f0000-0000-7000-8000-00000000000a";
const ID_B = "018f0000-0000-7000-8000-00000000000b";

function messages(input: Record<string, unknown>): string[] {
  const result = schema.safeParse(input);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe("sort fields", () => {
  it("accepts a declared key and a direction", () => {
    expect(schema.parse({ sort: "name", order: "desc" })).toMatchObject({
      sort: "name",
      order: "desc",
    });
  });

  it("refuses a key the list did not declare, naming the ones it did", () => {
    expect(messages({ sort: "password" })).toEqual([
      "Ordenação inválida. Use uma destas colunas: created_at, name.",
    ]);
  });

  it("refuses a direction other than asc or desc", () => {
    expect(messages({ order: "up" })).toEqual([
      "A direção da ordenação deve ser asc ou desc.",
    ]);
  });

  it("leaves both out when absent", () => {
    const parsed = schema.parse({});

    expect(parsed.sort).toBeUndefined();
    expect(parsed.order).toBeUndefined();
  });
});

describe("facet fields", () => {
  it("reads a comma-separated list, trimmed and without repeats", () => {
    expect(schema.parse({ status: " OPEN, CLOSED ,OPEN" }).status).toEqual([
      "OPEN",
      "CLOSED",
    ]);
  });

  it("reads the repeated form Fastify hands over as an array", () => {
    expect(schema.parse({ status: ["OPEN", "CLOSED"] }).status).toEqual([
      "OPEN",
      "CLOSED",
    ]);
  });

  it("treats an empty param as no filter", () => {
    expect(schema.parse({ status: "" }).status).toBeUndefined();
    expect(schema.parse({ status: " , " }).status).toBeUndefined();
  });

  it("refuses a value outside the set, naming it", () => {
    expect(messages({ status: "OPEN,DELETED" })).toEqual([
      'Valor de filtro inválido: "DELETED". Use: OPEN, CLOSED.',
    ]);
  });

  it("accepts ids and refuses anything that is not one", () => {
    expect(schema.parse({ typeId: `${ID_A},${ID_B}` }).typeId).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(messages({ typeId: `${ID_A},1 OR 1=1` })).toEqual([
      "Filtro com identificador inválido.",
    ]);
  });

  it("caps how many values one facet carries", () => {
    const tooMany = Array.from(
      { length: MAX_FACET_VALUES + 1 },
      (_, index) =>
        `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    );

    expect(messages({ typeId: tooMany.join(",") })).toEqual([
      `Filtro com valores demais: no máximo ${MAX_FACET_VALUES}.`,
    ]);
  });
});

describe("resolveOrderBy", () => {
  type OrderBy = Record<string, unknown>;

  const spec: SortSpec<"created_at" | "name", OrderBy> = {
    keys: ["created_at", "name"],
    fallback: { sort: "created_at", order: "desc" },
    columns: {
      created_at: (order) => ({ created_at: order }),
      name: (order) => ({ type: { name: order } }),
    },
    tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
  };

  it("falls back to the list's default order", () => {
    expect(resolveOrderBy(spec, {})).toEqual([
      { created_at: "desc" },
      { id: "desc" },
    ]);
  });

  it("sorts ascending when only the column is given", () => {
    expect(resolveOrderBy(spec, { sort: "name" })).toEqual([
      { type: { name: "asc" } },
      { created_at: "desc" },
      { id: "desc" },
    ]);
  });

  it("never repeats the sorted column as its own tiebreaker", () => {
    expect(resolveOrderBy(spec, { sort: "created_at", order: "asc" })).toEqual([
      { created_at: "asc" },
      { id: "desc" },
    ]);
  });
});

describe("sumCounts", () => {
  it("adds a breakdown", () => {
    expect(sumCounts([{ count: 2 }, { count: 3 }])).toBe(5);
    expect(sumCounts([])).toBe(0);
  });
});
