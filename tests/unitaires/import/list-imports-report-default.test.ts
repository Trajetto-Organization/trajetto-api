import { describe, expect, it } from "vitest";

import { listImportsSchema } from "@/schemas/import-spreadsheet-schema";

import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";

/**
 * The upload history leaves each upload's per-row report out unless asked.
 *
 * The Importações tab fetched the listing without the flag, and the default
 * used to be "with report": every page carried one JSON entry per spreadsheet
 * line of every upload on it — megabytes deep-copied, stringified and gzipped
 * on the event loop — to draw four counters per row. The report of one upload
 * comes from get-import when the operator opens it.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000a";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";

describe("the list-imports query", () => {
  it("defaults to no report, and still accepts includeReport=true", () => {
    const page = { page: "1", pageSize: "10" };

    expect(listImportsSchema.parse(page).includeReport).toBe(false);
    expect(
      listImportsSchema.parse({ ...page, includeReport: "false" })
        .includeReport,
    ).toBe(false);
    expect(
      listImportsSchema.parse({ ...page, includeReport: "true" }).includeReport,
    ).toBe(true);
  });
});

describe("the import repository's listing", () => {
  it("leaves the report key out unless the caller asks for it", async () => {
    const imports = new InMemoryImportRepository();

    await imports.createImport({
      source: "SPREADSHEET",
      filename: "dia.xlsx",
      businessId: BUSINESS,
      performedById: ADMIN,
    });

    const plain = await imports.listImports({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
    });

    expect(plain.data).toHaveLength(1);
    expect(plain.data[0]).not.toHaveProperty("report");

    const withReport = await imports.listImports({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
      includeReport: true,
    });

    expect(withReport.data[0].report).toMatchObject({ rows: [] });
  });
});
