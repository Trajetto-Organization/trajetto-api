import { describe, expect, it } from "vitest";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listImportsSchema } from "@/schemas/import-spreadsheet-schema";
import { listWebhookDeliveriesSchema } from "@/schemas/integration-schema";

/**
 * The offset lists take whole pages only, and not past the offset Prisma can
 * send (dlv-proof, measured on the proof queue: page=2.5 answered 200 with
 * 2.5 echoed in meta while the database coerced the offset).
 *
 * Junk, empty and zero still fall back to the defaults, which every screen
 * depends on; a fraction, a negative or a page past the ceiling is a 400.
 */
const lists = [
  ["listPagesSchema", listPagesSchema, {}],
  ["listImportsSchema", listImportsSchema, {}],
  ["listWebhookDeliveriesSchema", listWebhookDeliveriesSchema, {}],
] as const;

describe.each(lists)("%s", (_name, schema, rest) => {
  const parse = (query: Record<string, string>) =>
    (
      schema as {
        safeParse: (value: unknown) => { success: boolean; data?: unknown };
      }
    ).safeParse({
      page: "1",
      pageSize: "10",
      ...rest,
      ...query,
    });

  it("refuses a fractional page", () => {
    expect(parse({ page: "2.5" }).success).toBe(false);
  });

  it("refuses a page past the ceiling", () => {
    expect(parse({ page: "1000001" }).success).toBe(false);
    expect(parse({ page: "1000000" }).success).toBe(true);
  });

  it("refuses a fractional page size", () => {
    expect(parse({ pageSize: "10.5" }).success).toBe(false);
  });

  it("still reads junk and zero as the defaults", () => {
    const junk = parse({ page: "abc", pageSize: "0" });

    expect(junk.success).toBe(true);
    expect((junk.data as { page: number }).page).toBe(1);
  });
});
