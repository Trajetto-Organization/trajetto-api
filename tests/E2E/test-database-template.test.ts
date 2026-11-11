import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

import { templateName } from "../../prisma/vitest-environment-prisma/template";

/**
 * This file's database is a clone of the E2E template
 * (prisma/vitest-environment-prisma/template.ts), not a database migrated
 * for it. What every other file relies on without checking: the clone has
 * every migration of the tree, applied and finished, the extension one of
 * them installs, and the template it came from is marked so that nobody
 * connects to it (CREATE DATABASE … TEMPLATE refuses a template with a
 * session on it).
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

const migrations = readdirSync(join(process.cwd(), "prisma", "migrations"))
  .filter((name) =>
    statSync(join(process.cwd(), "prisma", "migrations", name)).isDirectory(),
  )
  .sort();

describe("the database of an E2E file", () => {
  it("has every migration of the tree, each one finished", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished: boolean }>
    >`
      SELECT migration_name, finished_at IS NOT NULL AND rolled_back_at IS NULL AS finished
      FROM _prisma_migrations
      ORDER BY migration_name
    `;

    expect(rows.map((row) => row.migration_name)).toEqual(migrations);
    expect(rows.filter((row) => !row.finished)).toEqual([]);
  });

  it("has the extension a migration installs", async () => {
    const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension ORDER BY extname
    `;

    expect(rows.map((row) => row.extname)).toEqual(
      expect.arrayContaining(["pg_trgm", "plpgsql"]),
    );
  });

  it("has this tree's template beside it, marked so that nobody connects to it", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ datname: string; datistemplate: boolean; datallowconn: boolean }>
    >`
      SELECT datname, datistemplate, datallowconn
      FROM pg_database
      WHERE datname = ${templateName()}
    `;

    expect(rows).toEqual([
      { datname: templateName(), datistemplate: true, datallowconn: false },
    ]);
  });
});
