import { describe, expect, it } from "vitest";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { MAX_PAGE_SIZE, pageSizeField } from "@/shared/pagination/page-size";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";
import { listUserNotificationsCursorSchema } from "@/schemas/list-user-notification-cursor-schema";

import { z } from "zod";

/**
 * Two ways a list query could go wrong, both reachable from a plain query
 * string on an authenticated endpoint.
 */

describe("the OR of a list search", () => {
  it("drops a condition that would make the whole clause true", () => {
    // `{}` is an empty conjunction, which is TRUE, so one of them satisfies
    // the OR on its own and the search term stops mattering entirely.
    const built = buildSearchOr([
      { name: { contains: "João" } },
      {},
      { email: { contains: "João" } },
    ]);

    expect(built).toEqual({
      OR: [{ name: { contains: "João" } }, { email: { contains: "João" } }],
    });
  });

  it("is exactly what a non-MASTER produces today", () => {
    // The shape that was in eight repositories: a MASTER-only clause written
    // as a spread inside an object literal, which for everyone else is `{}`.
    const currentUserRole: string = "BUSINESS_ADMIN";
    const search = "João";

    const built = buildSearchOr([
      { name: { contains: search, mode: "insensitive" } },
      {
        ...(currentUserRole === "MASTER"
          ? { businessId: { contains: search, mode: "insensitive" } }
          : {}),
      },
    ]);

    expect(built).toEqual({
      OR: [{ name: { contains: search, mode: "insensitive" } }],
    });
  });

  it("keeps the MASTER clause when the caller really is a MASTER", () => {
    const currentUserRole: string = "MASTER";
    const search = "Transportadora";

    const built = buildSearchOr([
      { name: { contains: search } },
      {
        ...(currentUserRole === "MASTER"
          ? { businessId: { contains: search } }
          : {}),
      },
    ]);

    expect(built).toEqual({
      OR: [
        { name: { contains: search } },
        { businessId: { contains: search } },
      ],
    });
  });

  it("omits the OR key entirely when nothing was searched for", () => {
    // An `OR: []` matches NOTHING in Prisma, which would empty every list.
    expect(buildSearchOr([])).toEqual({});
    expect(buildSearchOr([{}, {}])).toEqual({});
  });

  it("never touches the tenant filter, which sits beside it", () => {
    // The reason a tautological OR was never a cross-carrier leak: businessId
    // is a top-level key, in AND with the OR, never a member of it.
    const where = {
      businessId: "business-a",
      ...buildSearchOr([{}]),
    };

    expect(where).toEqual({ businessId: "business-a" });
    expect(where).not.toHaveProperty("OR");
  });
});

describe("how many rows one request may ask for", () => {
  const parse = (pageSize: string) =>
    listPagesSchema.safeParse({ page: "1", pageSize });

  it("accepts what the panel actually sends", () => {
    // The table's own picker stops at 50; the chat thread list asks for 100.
    for (const size of ["10", "20", "30", "40", "50", "100"]) {
      expect(parse(size).success).toBe(true);
    }
  });

  it("refuses a page size above the ceiling", () => {
    // `pageSize` goes straight into Prisma's `take`, so this URL asked one
    // Postgres backend to materialise a million rows and one Node process to
    // hold them. No exploit, just a number.
    expect(parse("1000000").success).toBe(false);
    expect(parse(String(MAX_PAGE_SIZE + 1)).success).toBe(false);
  });

  it("holds for the cursor-paginated lists too", () => {
    expect(cursorPaginationSchema.safeParse({ limit: "100" }).success).toBe(
      true,
    );
    expect(cursorPaginationSchema.safeParse({ limit: "5000" }).success).toBe(
      false,
    );
  });

  it("holds for the notification feed, which had no ceiling at all", () => {
    const parsed = listUserNotificationsCursorSchema.safeParse({
      limit: "999999",
    });

    expect(parsed.success).toBe(false);
  });

  it("still defaults when the value is missing or junk", () => {
    // Deliberately unchanged: every screen already depends on a malformed
    // pageSize falling back rather than failing the request.
    const schema = z.object({ pageSize: pageSizeField(10) });

    expect(schema.parse({ pageSize: "abc" }).pageSize).toBe(10);
    expect(schema.parse({ pageSize: "0" }).pageSize).toBe(10);
  });
});
