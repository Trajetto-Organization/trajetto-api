import { describe, expect, it } from "vitest";

import {
  escapeLikePattern,
  insensitiveEquals,
} from "@/shared/utils/like-pattern";

/**
 * Exact, case-insensitive matches are patterns underneath.
 *
 * Prisma turns `{ equals: value, mode: "insensitive" }` into `"col" ILIKE $1`
 * on Postgres, and passes the value as the pattern as it came. A `%` or `_`
 * typed into a form was a wildcard: a CNH of "1%" matched any CNH starting
 * with 1, in any tenant, and the "not available" error told the caller so —
 * one character at a time, a stranger's document number could be read back.
 */
describe("escapeLikePattern", () => {
  it("puts a backslash before each wildcard and before the escape itself", () => {
    expect(escapeLikePattern("1%")).toBe("1\\%");
    expect(escapeLikePattern("j_hn")).toBe("j\\_hn");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("%_\\")).toBe("\\%\\_\\\\");
  });

  it("leaves everything else alone", () => {
    expect(escapeLikePattern("ABC1D23")).toBe("ABC1D23");
    expect(escapeLikePattern("contato@empresa.com.br")).toBe(
      "contato@empresa.com.br",
    );
    expect(escapeLikePattern("Transportes São João Ltda.")).toBe(
      "Transportes São João Ltda.",
    );
  });
});

describe("insensitiveEquals", () => {
  it("is Prisma's case-insensitive equality over the escaped value", () => {
    expect(insensitiveEquals("1%")).toEqual({
      equals: "1\\%",
      mode: "insensitive",
    });
  });
});
