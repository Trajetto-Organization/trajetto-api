import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What infra/sql and prisma/post-deploy may never do (plano-escala F5-08,
 * D18, the security review).
 *
 * The release step reapplies infra/sql on EVERY release, as the migration
 * user. A file there that touched a role's LOGIN or PASSWORD would, on the
 * next release, lock the runtime out of its own database (or put a
 * password in the repository); a DROP ROLE would take the grants with it.
 * So a role is only ever created NOLOGIN, and only when missing; login and
 * password stay the owner's, by hand. And no Prisma migration names a role:
 * migrations run once and are history, and a restore with --no-owner would
 * lose what they granted — that convergence is infra/sql's job. Nor may a
 * step give any role the powers that read the Database's server (the PITR's
 * keys are there, F1-25).
 *
 * Every step file also says what it did, in the NOTICE the runner reads
 * (release-step-runner.ts): without it the step fails at release time; here
 * it fails first.
 */
const ROOT = process.cwd();

/** The SQL with comments removed; literals and $$ bodies kept (EXECUTE '...'). */
function codeOf(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The dollar-quoted bodies of a script: `DO $$ ... $$`, functions. */
function dollarBlocks(code: string): string[] {
  return [...code.matchAll(/\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1\$/g)].map(
    (match) => match[2],
  );
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [
    /\bALTER\s+(?:ROLE|USER)\b[^;']*\b(?:NO)?LOGIN\b/i,
    "ALTER ROLE com LOGIN/NOLOGIN",
  ],
  [/\bALTER\s+(?:ROLE|USER)\b[^;']*\bPASSWORD\b/i, "ALTER ROLE com PASSWORD"],
  [/\bDROP\s+(?:ROLE|USER)\b/i, "DROP ROLE"],
  [/\bCREATE\s+USER\b/i, "CREATE USER"],
  [/\bALTER\s+USER\b/i, "ALTER USER"],
  // The PITR's write key and cipher live in the environment of the
  // Database's container (plano-escala D61, F1-25). A runtime role that is
  // a superuser, a member of a built-in role that runs a program or reads
  // or writes a server file, or allowed a server-side file function would
  // read them there (`COPY … FROM PROGRAM 'env'`, `lo_import` of
  // /proc/self/environ) and delete the backups. The roles' cut is what
  // keeps an SQL injection away from them; a release step must never undo
  // it. (NOSUPERUSER has no word boundary before SUPERUSER.)
  [/\b(?:CREATE|ALTER)\s+ROLE\b[^;']*\bSUPERUSER\b/i, "role com SUPERUSER"],
  [
    /\bpg_(?:execute_server_program|read_server_files|write_server_files)\b/i,
    "role que roda programa ou lê arquivo do servidor",
  ],
  [
    /\b(?:lo_import|lo_export|pg_read_file|pg_read_binary_file)\b/i,
    "função que lê ou grava arquivo do servidor",
  ],
];

/** The rules of one infra/sql (or post-deploy) file. */
function stepProblems(name: string, sql: string): string[] {
  const code = codeOf(sql);
  const problems: string[] = [];

  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(code)) problems.push(`${name}: ${what}`);
  }

  const creates = [...code.matchAll(/\bCREATE\s+ROLE\b[^;']*(?=;|'|$)/gi)].map(
    (match) => match[0],
  );

  for (const create of creates) {
    if (!/\bNOLOGIN\b/i.test(create) || /(?<!NO)LOGIN\b/i.test(create)) {
      problems.push(`${name}: CREATE ROLE sem NOLOGIN`);
    }
    if (/\bPASSWORD\b/i.test(create)) {
      problems.push(`${name}: CREATE ROLE com PASSWORD`);
    }
  }

  if (creates.length > 0) {
    const guarded = dollarBlocks(code).filter(
      (block) =>
        /\bCREATE\s+ROLE\b/i.test(block) &&
        /\bpg_(?:catalog\.)?roles\b|\bpg_catalog\.pg_roles\b|\bduplicate_object\b/i.test(
          block,
        ),
    );
    const inBlocks = dollarBlocks(code)
      .map((block) => [...block.matchAll(/\bCREATE\s+ROLE\b/gi)].length)
      .reduce((sum, count) => sum + count, 0);
    const inGuarded = guarded
      .map((block) => [...block.matchAll(/\bCREATE\s+ROLE\b/gi)].length)
      .reduce((sum, count) => sum + count, 0);

    if (inGuarded < creates.length || inBlocks < creates.length) {
      problems.push(
        `${name}: CREATE ROLE fora de um bloco que confere se o role existe (pg_roles)`,
      );
    }
  }

  if (!/RAISE\s+NOTICE\s+'(?:applied|skipped|pending):/i.test(code)) {
    problems.push(
      `${name}: sem RAISE NOTICE 'applied: …', 'skipped: …' ou 'pending: …'`,
    );
  }

  return problems;
}

/** Anything in a Prisma migration that names a role. */
function migrationProblems(name: string, sql: string): string[] {
  const code = codeOf(sql);

  return [
    /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bOWNER\s+TO\b/i,
    /\bSET\s+(?:LOCAL\s+)?ROLE\b/i,
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i,
  ]
    .filter((pattern) => pattern.test(code))
    .map((pattern) => `${name}: ${pattern.source}`);
}

function sqlFiles(dir: string): Array<{ name: string; sql: string }> {
  return readdirSync(resolve(ROOT, dir))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({
      name: `${dir}/${name}`,
      sql: readFileSync(resolve(ROOT, dir, name), "utf8"),
    }));
}

describe("the repository's release steps and migrations", () => {
  it("infra/sql and prisma/post-deploy follow the rules", () => {
    const files = [...sqlFiles("infra/sql"), ...sqlFiles("prisma/post-deploy")];

    expect(files.flatMap(({ name, sql }) => stepProblems(name, sql))).toEqual(
      [],
    );
  });

  it("no Prisma migration names a role", () => {
    const migrations = readdirSync(resolve(ROOT, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        sql: readFileSync(
          join(ROOT, "prisma/migrations", entry.name, "migration.sql"),
          "utf8",
        ),
      }));

    expect(migrations.length).toBeGreaterThan(100);
    expect(
      migrations.flatMap(({ name, sql }) => migrationProblems(name, sql)),
    ).toEqual([]);
  });
});

describe("the rules, on planted files", () => {
  const GOOD = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trajetto_app') THEN
    CREATE ROLE trajetto_app NOLOGIN;
    RAISE NOTICE 'applied: trajetto_app criado';
  ELSE
    RAISE NOTICE 'skipped: trajetto_app já existe';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO trajetto_app;
`;

  it("accept a NOLOGIN role created only when missing, with its NOTICE", () => {
    expect(stepProblems("10-roles.sql", GOOD)).toEqual([]);
  });

  it.each([
    [
      "ALTER ROLE … PASSWORD",
      `${GOOD}\nALTER ROLE trajetto_app PASSWORD 'x';`,
      "10-x.sql: ALTER ROLE com PASSWORD",
    ],
    [
      "ALTER ROLE … LOGIN",
      `${GOOD}\nALTER ROLE trajetto_app LOGIN;`,
      "10-x.sql: ALTER ROLE com LOGIN/NOLOGIN",
    ],
    [
      "ALTER ROLE … NOLOGIN (locks the runtime out)",
      `${GOOD}\nALTER ROLE trajetto WITH NOLOGIN;`,
      "10-x.sql: ALTER ROLE com LOGIN/NOLOGIN",
    ],
    [
      "a password through EXECUTE",
      `${GOOD}\nDO $$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L', 'a', 'b'); END $$;`,
      "10-x.sql: ALTER ROLE com PASSWORD",
    ],
    ["DROP ROLE", `${GOOD}\nDROP ROLE trajetto_old;`, "10-x.sql: DROP ROLE"],
    ["CREATE USER", `${GOOD}\nCREATE USER x;`, "10-x.sql: CREATE USER"],
    [
      "a superuser, through EXECUTE",
      `${GOOD}\nDO $$ BEGIN EXECUTE format('ALTER ROLE %I SUPERUSER', 'trajetto_batch'); END $$;`,
      "10-x.sql: role com SUPERUSER",
    ],
    [
      "a role that reads the server's files",
      `${GOOD}\nGRANT pg_read_server_files TO trajetto_batch;`,
      "10-x.sql: role que roda programa ou lê arquivo do servidor",
    ],
    [
      "a role that runs a program, from a list",
      `${GOOD}\nDO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['pg_monitor', 'pg_execute_server_program'] LOOP EXECUTE format('GRANT %I TO trajetto_batch', r); END LOOP; END $$;`,
      "10-x.sql: role que roda programa ou lê arquivo do servidor",
    ],
    [
      "a server-side file function",
      `${GOOD}\nGRANT EXECUTE ON FUNCTION lo_import(text) TO trajetto_app;`,
      "10-x.sql: função que lê ou grava arquivo do servidor",
    ],
  ])("refuse %s", (_case, sql, problem) => {
    expect(stepProblems("10-x.sql", sql)).toContain(problem);
  });

  it("accept a role that is explicitly not a superuser", () => {
    expect(
      stepProblems("10-x.sql", `${GOOD}\nALTER ROLE trajetto_app NOSUPERUSER;`),
    ).toEqual([]);
  });

  it("refuse a role created with LOGIN, or without the existence check", () => {
    expect(
      stepProblems(
        "10-x.sql",
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'a') THEN CREATE ROLE a LOGIN; END IF; RAISE NOTICE 'applied: a'; END $$;`,
      ),
    ).toContain("10-x.sql: CREATE ROLE sem NOLOGIN");
    expect(
      stepProblems(
        "10-x.sql",
        `CREATE ROLE a NOLOGIN;\nDO $$ BEGIN RAISE NOTICE 'applied: a'; END $$;`,
      ),
    ).toContain(
      "10-x.sql: CREATE ROLE fora de um bloco que confere se o role existe (pg_roles)",
    );
  });

  it("refuse a step that does not say what it did", () => {
    expect(
      stepProblems("20-x.sql", "GRANT USAGE ON SCHEMA public TO trajetto_app;"),
    ).toEqual([
      "20-x.sql: sem RAISE NOTICE 'applied: …', 'skipped: …' ou 'pending: …'",
    ]);
  });

  it("ignore what a comment says", () => {
    expect(
      stepProblems("10-x.sql", `${GOOD}\n-- never ALTER ROLE x PASSWORD here`),
    ).toEqual([]);
  });

  it("find a role named in a migration", () => {
    expect(
      migrationProblems("20261201_x", "GRANT SELECT ON a TO trajetto_app;"),
    ).toEqual(["20261201_x: \\bGRANT\\b"]);
    expect(
      migrationProblems(
        "20261201_y",
        'ALTER TABLE "a" OWNER TO trajetto_partitions;',
      ),
    ).toHaveLength(1);
    expect(
      migrationProblems("20261201_z", 'CREATE TABLE "a" ("grant_id" text);'),
    ).toEqual([]);
  });
});
