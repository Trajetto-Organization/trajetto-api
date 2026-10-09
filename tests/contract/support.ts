import { Prisma } from "@prisma/client";
import { expect } from "vitest";

/**
 * Shared pieces of the repository contract suites (decision 13.2).
 *
 * A suite under tests/contract/repositories/ describes ONE repository's
 * behaviour as a function of a harness, and its runner in tests/E2E/ calls it
 * twice: with the Prisma repository over the per-file Postgres database, and
 * with the in-memory twin seeded with the same rows. The expectations are the
 * same object for both, so a twin that orders, filters, paginates or fails
 * differently from the database fails here instead of in a unit test that
 * proves something the screen never shows.
 */

type Kind = "prisma" | "in-memory";

const KINDS: readonly Kind[] = ["prisma", "in-memory"] as const;

/** Resolves to the Prisma error code a write raised (P2002, P2025, ...). */
async function prismaCodeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError)
      return error.code;

    throw error;
  }

  throw new Error("expected the write to fail, and it succeeded");
}

async function expectPrismaCode(
  work: Promise<unknown>,
  code: "P2002" | "P2003" | "P2025",
): Promise<void> {
  expect(await prismaCodeOf(work)).toBe(code);
}

/** A deterministic UUID per (prefix, n), so `id desc` tiebreakers are predictable. */
function fixedId(prefix: string, n: number): string {
  const head = prefix.padEnd(8, "0").slice(0, 8);

  return `${head}-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

/** A minute offset from a fixed instant: created_at values the suite controls. */
function minute(offset: number, base = Date.UTC(2026, 8, 1, 12, 0, 0)): Date {
  return new Date(base + offset * 60_000);
}

/** Deep copy of seeded rows, so the twin never shares objects with the fixtures. */
function clone<T>(rows: T): T {
  return structuredClone(rows);
}

export { KINDS, clone, expectPrismaCode, fixedId, minute, prismaCodeOf };
export type { Kind };
