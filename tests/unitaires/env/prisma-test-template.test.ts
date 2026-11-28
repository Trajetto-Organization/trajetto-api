import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureTemplate,
  quoteIdent,
  TEMPLATE_INPUTS,
  templateName,
} from "../../../prisma/vitest-environment-prisma/template";

/**
 * A server for the builder: pg's Client records every statement, keeps the
 * databases and their template mark, and holds the advisory lock the way
 * Postgres does (one session at a time, released when it ends). The migrate
 * (`execSync`) is recorded too, and can be made to fail.
 */
const server = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    /** name → marked as a template */
    databases: new Map<string, boolean>(),
    migrateFails: false,
    stepsFail: false,
    holder: null as object | null,
    waiting: [] as Array<() => void>,
  };

  return {
    state,
    reset() {
      state.log = [];
      state.databases = new Map();
      state.migrateFails = false;
      state.stepsFail = false;
      state.holder = null;
      state.waiting = [];
    },
  };
});

vi.mock("pg", () => {
  const { state } = server;

  class Client {
    private ended = false;

    async connect() {}

    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("SELECT pg_advisory_lock")) {
        while (state.holder && state.holder !== this) {
          await new Promise<void>((resolve) => state.waiting.push(resolve));
        }
        state.holder = this;
        state.log.push("lock");

        return { rows: [] };
      }

      if (sql.startsWith("SELECT datistemplate")) {
        const name = params[0] as string;

        state.log.push(`look ${name}`);

        return state.databases.has(name)
          ? { rows: [{ datistemplate: state.databases.get(name) }] }
          : { rows: [] };
      }

      if (sql.startsWith("SELECT datname")) {
        const [prefix, keep] = params as [string, string];

        state.log.push(`list others than ${keep}`);

        return {
          rows: [...state.databases.keys()]
            .filter((name) => name.startsWith(prefix) && name !== keep)
            .map((datname) => ({ datname })),
        };
      }

      const name = /"([^"]+)"/.exec(sql)?.[1] ?? "";

      if (sql.startsWith("DROP DATABASE")) state.databases.delete(name);
      if (sql.startsWith("CREATE DATABASE")) state.databases.set(name, false);
      if (sql.includes("IS_TEMPLATE true")) state.databases.set(name, true);
      if (sql.includes("IS_TEMPLATE false") && state.databases.has(name)) {
        state.databases.set(name, false);
      }
      state.log.push(sql);

      return { rows: [] };
    }

    async end() {
      if (this.ended) return;
      this.ended = true;
      state.log.push("end");
      if (state.holder === this) {
        state.holder = null;
        state.waiting.splice(0).forEach((resolve) => resolve());
      }
    }
  }

  return { default: { Client } };
});

vi.mock("node:child_process", () => ({
  execSync: (command: string, options: { env: Record<string, string> }) => {
    const database = new URL(options.env.DATABASE_URL).pathname.slice(1);

    server.state.log.push(`${command} into ${database}`);
    if (server.state.migrateFails) throw new Error("migration failed");
    if (server.state.stepsFail && command.includes("release:steps")) {
      throw new Error("release step failed");
    }
  },
}));

/**
 * The E2E template's name is the key of what `prisma migrate deploy` reads
 * (prisma/vitest-environment-prisma/template.ts): every file's database is a
 * clone of it, so a template left from other migrations would test the
 * suite against a schema the tree does not have. Another key is another
 * template, and nothing else may change it — or every run would migrate
 * again and the clone would save nothing.
 */
let root = "";

const write = (path: string, content: string) => {
  const file = join(root, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trajetto-template-"));
  write(
    "prisma/migrations/20260101000000_init/migration.sql",
    'CREATE TABLE "a" ();\n',
  );
  write("prisma/migrations/migration_lock.toml", 'provider = "postgresql"\n');
  write("prisma/schema.prisma", "model A { id Int @id }\n");
  write("prisma.config.ts", "export default {};\n");
  write("node_modules/prisma/package.json", '{ "version": "7.10.1" }\n');
  write("src/server.ts", "export {};\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the E2E template's name", () => {
  it("is a valid identifier with the key in it, the same every time", () => {
    const name = templateName(root);

    expect(name).toMatch(/^trajetto_tpl_[0-9a-f]{16}$/);
    expect(templateName(root)).toBe(name);
  });

  it.each([
    ["a new migration", "prisma/migrations/20260202000000_next/migration.sql"],
    [
      "an edited migration",
      "prisma/migrations/20260101000000_init/migration.sql",
    ],
    ["the schema", "prisma/schema.prisma"],
    ["the Prisma config", "prisma.config.ts"],
    ["another Prisma CLI", "node_modules/prisma/package.json"],
    // F5-08: the template is a database as a release leaves it.
    ["a step of infra/sql", "infra/sql/10-roles.sql"],
    ["a post-deploy step", "prisma/post-deploy/10-swap.sql"],
    ["the steps' runner", "infra/scripts/release-step-runner.ts"],
  ])("changes with %s", (_, path) => {
    const before = templateName(root);

    write(path, "-- changed\n");

    expect(templateName(root)).not.toBe(before);
  });

  it("does not change with the rest of the tree, nor with line endings", () => {
    const before = templateName(root);

    write("src/server.ts", "export const changed = true;\n");
    write("docs/testes.md", "# changed\n");
    write(
      "prisma/migrations/20260101000000_init/migration.sql",
      'CREATE TABLE "a" ();\r\n',
    );

    expect(templateName(root)).toBe(before);
  });

  it("reads the tree's real inputs", () => {
    expect(TEMPLATE_INPUTS).toEqual([
      "prisma/migrations",
      "prisma/schema.prisma",
      "prisma.config.ts",
      "node_modules/prisma/package.json",
      "infra/sql",
      "prisma/post-deploy",
      "infra/scripts/release-steps.ts",
      "infra/scripts/release-step-runner.ts",
    ]);
    expect(templateName()).toMatch(/^trajetto_tpl_[0-9a-f]{16}$/);
  });
});

describe("the identifiers in its statements", () => {
  it("are quoted, with a double quote inside doubled", () => {
    expect(quoteIdent("trajetto_tpl_0123456789abcdef")).toBe(
      '"trajetto_tpl_0123456789abcdef"',
    );
    expect(quoteIdent('x" WITH (FORCE); --')).toBe('"x"" WITH (FORCE); --"');
  });
});

/**
 * The builder (`ensureTemplate`): what keeps a clone from ever carrying a
 * half-migrated schema or another tree's migrations. A regression here would
 * not fail one test: every E2E file would run on the wrong schema, or the
 * suite would turn flaky.
 */
describe("the E2E template's builder", () => {
  const BASE = "postgresql://postgres:postgres@localhost:5432/test_db";
  const MIGRATE = "yarn prisma migrate deploy";

  beforeEach(() => server.reset());

  it("migrates a missing template once, under the lock, and marks it only after the last migration", async () => {
    const name = templateName(root);

    await expect(ensureTemplate(BASE, root)).resolves.toBe(name);

    expect(server.state.log).toEqual([
      "lock",
      `look ${name}`,
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      `list others than ${name}`,
      `CREATE DATABASE "${name}"`,
      `${MIGRATE} into ${name}`,
      `yarn release:steps into ${name}`,
      `ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      "end",
    ]);
  });

  // The steps after the migrations are part of the template: one that
  // fails leaves it unmarked, never cloned.
  it("leaves the template unmarked when a step after the migrations fails", async () => {
    const name = templateName(root);

    server.state.stepsFail = true;

    await expect(ensureTemplate(BASE, root)).rejects.toThrow(
      "release step failed",
    );

    expect(server.state.databases.get(name)).toBe(false);
    expect(server.state.holder).toBeNull();
  });

  it("hands a marked template back as it is: no migrate, no drop", async () => {
    const name = templateName(root);

    server.state.databases.set(name, true);

    await expect(ensureTemplate(BASE, root)).resolves.toBe(name);

    expect(server.state.log).toEqual(["lock", `look ${name}`, "end"]);
  });

  // A builder that died between CREATE and the mark left it unmarked: a
  // clone of it would carry half the migrations.
  it("drops an unmarked template and builds it again, never clones it", async () => {
    const name = templateName(root);

    server.state.databases.set(name, false);

    await ensureTemplate(BASE, root);

    const log = server.state.log;

    expect(log.indexOf(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).toBe(
      2,
    );
    expect(log.indexOf(`${MIGRATE} into ${name}`)).toBeGreaterThan(
      log.indexOf(`CREATE DATABASE "${name}"`),
    );
    expect(server.state.databases.get(name)).toBe(true);
  });

  it("prunes the templates of other keys, unmarked first, and never its own", async () => {
    const name = templateName(root);
    const stale = "trajetto_tpl_0000000000000000";

    server.state.databases.set(stale, true);
    server.state.databases.set("test_db", false);

    await ensureTemplate(BASE, root);

    const log = server.state.log;
    const unmark = log.indexOf(
      `ALTER DATABASE "${stale}" WITH IS_TEMPLATE false`,
    );
    const drop = log.indexOf(`DROP DATABASE IF EXISTS "${stale}" WITH (FORCE)`);

    expect(unmark).toBeGreaterThan(log.indexOf(`list others than ${name}`));
    expect(drop).toBeGreaterThan(unmark);
    expect(drop).toBeLessThan(log.indexOf(`CREATE DATABASE "${name}"`));
    expect([...server.state.databases.keys()].sort()).toEqual(
      [name, "test_db"].sort(),
    );
  });

  it("leaves a template whose migrate failed unmarked, and still lets go of the lock", async () => {
    const name = templateName(root);

    server.state.migrateFails = true;

    await expect(ensureTemplate(BASE, root)).rejects.toThrow(
      "migration failed",
    );

    expect(server.state.log).not.toContain(
      `ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
    expect(server.state.databases.get(name)).toBe(false);
    expect(server.state.log[server.state.log.length - 1]).toBe("end");
    expect(server.state.holder).toBeNull();
  });

  it("builds once when files start together: the others wait on the lock and find it done", async () => {
    const name = templateName(root);

    await expect(
      Promise.all([1, 2, 3].map(() => ensureTemplate(BASE, root))),
    ).resolves.toEqual([name, name, name]);

    expect(
      server.state.log.filter((line) => line.startsWith(MIGRATE)),
    ).toHaveLength(1);
    expect(server.state.log.filter((line) => line === "lock")).toHaveLength(3);
  });
});
