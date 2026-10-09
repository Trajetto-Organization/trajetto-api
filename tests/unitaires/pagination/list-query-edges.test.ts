import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compareCodePoints, compareForOrder } from "@/shared/pagination/in-memory-order";
import { searchMetaDoc, sumCounts } from "@/shared/pagination/list-meta";
import { MAX_FACET_VALUES, facetField, idFacetField, resolveOrderBy, sortFields } from "@/shared/pagination/list-query";
import { MAX_PAGE_SIZE, PAGE_DESCRIPTION, pageField, pageSizeField } from "@/shared/pagination/page-size";

/**
 * Edges of list-query parsing left alive by the 06/10 mutation run: the
 * messages a client reads on a bad sort, order, facet or page, the facet
 * size boundary, the descriptions /docs publishes, and the in-memory order
 * the repository twins use (booleans, dates, strings sharing a prefix).
 */

const issues = (schema: z.ZodTypeAny, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("sortFields", () => {
  const fields = sortFields(["name", "created_at"] as const, { sort: "created_at", order: "desc" });

  it("says which columns and directions exist", () => {
    expect(issues(fields.sort, "price")).toEqual(["Ordenação inválida. Use uma destas colunas: name, created_at."]);
    expect(issues(fields.order, "up")).toEqual(["A direção da ordenação deve ser asc ou desc."]);
    expect(fields.sort.parse("name")).toBe("name");
  });

  it("documents the columns and the default", () => {
    expect(fields.sort.description).toBe("Coluna da ordenação: name, created_at. Ausente, created_at desc.");
    expect(fields.order.description).toBe(
      "asc ou desc. Com `sort` informado e sem `order`, asc. Sem nenhum dos dois, a ordem padrão.",
    );
  });
});

describe("facetField", () => {
  const status = facetField(["OPEN", "CLOSED"] as const, "Situação.");

  it("accepts the repeated form and exactly the maximum number of values", () => {
    expect(status.parse(["OPEN", "CLOSED"])).toEqual(["OPEN", "CLOSED"]);

    const ids = idFacetField("Tipo.");
    const many = Array.from({ length: MAX_FACET_VALUES }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(ids.parse(many.join(","))).toHaveLength(MAX_FACET_VALUES);
    expect(issues(ids, [...many, "00000000-0000-4000-8000-999999999999"].join(","))).toEqual([
      `Filtro com valores demais: no máximo ${MAX_FACET_VALUES}.`,
    ]);
  });

  it("stops at the size before judging each value", () => {
    const tooMany = Array.from({ length: MAX_FACET_VALUES + 1 }, (_, index) => `V${index}`).join(",");

    expect(issues(status, tooMany)).toEqual([`Filtro com valores demais: no máximo ${MAX_FACET_VALUES}.`]);
  });

  it("refuses an unknown value without reporting it twice", () => {
    expect(issues(status, "OPEN,LOST")).toEqual(['Valor de filtro inválido: "LOST". Use: OPEN, CLOSED.']);
  });

  it("documents its values and its limit", () => {
    expect(status.description).toBe("Situação. Um ou mais valores separados por vírgula: OPEN, CLOSED.");
    expect(idFacetField("Tipo.").description).toBe(`Tipo. Um ou mais IDs separados por vírgula (até ${MAX_FACET_VALUES}).`);
  });
});

describe("resolveOrderBy", () => {
  const spec = {
    keys: ["name", "created_at"] as const,
    fallback: { sort: "created_at" as const, order: "desc" as const },
    columns: {
      name: (order: "asc" | "desc") => ({ name: order }),
      created_at: (order: "asc" | "desc") => ({ created_at: order }),
    },
    tiebreaker: [{ id: "asc" }, null] as never[],
  };

  it("keeps a tiebreaker entry that is not an object", () => {
    expect(resolveOrderBy(spec as never, { sort: "name" })).toEqual([{ name: "asc" }, { id: "asc" }, null]);
  });
});

describe("page fields", () => {
  it("refuses a page size of zero after the fallback, and says the bounds", () => {
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(pageSizeField(10).parse("1")).toBe(1);
    expect(issues(pageSizeField(0), "0")).toEqual(["A quantidade de itens por página deve ser um número inteiro entre 1 e 100."]);
    expect(pageSizeField(10).description).toBe("Itens por página, inteiro de 1 a 100; vazio ou inválido vira 10.");
  });

  it("falls back to page 1 and refuses what is out of range", () => {
    expect(pageField().parse("")).toBe(1);
    expect(pageField().parse("7")).toBe(7);
    expect(issues(pageField(), "1000001")).toEqual(["A página deve ser um número inteiro de 1 a 1.000.000."]);
    expect(issues(pageField(), "-2")).toEqual(["A página deve ser um número inteiro de 1 a 1.000.000."]);
    expect(pageField().description).toBe(PAGE_DESCRIPTION);
    expect(PAGE_DESCRIPTION).toBe(
      "Página pedida, inteiro de 1 a 1.000.000; vazio, zero ou não numérico vira 1; fração, negativo ou acima do limite: 400 VALIDATION_ERROR.",
    );
  });
});

describe("searchMetaDoc and sumCounts", () => {
  it("documents the cards and each facet's options", () => {
    const doc = searchMetaDoc({ open: z.number() }, ["status"] as const);

    expect(doc.parse({ open: 3, facets: { status: [{ value: "OPEN", count: 3 }] } })).toEqual({
      open: 3,
      facets: { status: [{ value: "OPEN", count: 3 }] },
    });
    expect(doc.shape.facets.description).toBe(
      "Opções dos filtros do servidor, cada uma com a contagem que traria (os demais filtros aplicados, o próprio não).",
    );
    const option = doc.shape.facets.shape.status.element;
    expect([option.shape.value.description, option.shape.label.description, option.shape.count.description]).toEqual([
      "O valor a enviar no parâmetro do filtro.",
      "Rótulo do valor, quando vem de um cadastro (o nome do tipo).",
      "Quantos registros o valor traria, com os demais filtros aplicados.",
    ]);
    expect(sumCounts([{ count: 2 }, { count: 5 }])).toBe(7);
  });
});

describe("in-memory order", () => {
  it("orders booleans false first and dates by instant", () => {
    expect(compareForOrder(false, true, "asc")).toBe(-1);
    expect(compareForOrder(true, false, "asc")).toBe(1);
    expect(compareForOrder(new Date(1000), new Date(2000), "asc")).toBe(-1);
    expect(compareForOrder(new Date(2000), new Date(2000), "asc")).toBe(0);
  });

  it("steps over U+FFFF as one code unit", () => {
    expect(compareCodePoints("\uffffa", "\uffffb")).toBe(-1);
  });

  it("puts the shorter of two strings sharing a prefix first", () => {
    expect(compareCodePoints("Ana", "Ana Maria")).toBe(-1);
    expect(compareCodePoints("Ana Maria", "Ana")).toBe(1);
    expect(compareCodePoints("Ana", "Ana")).toBe(0);
  });
});
