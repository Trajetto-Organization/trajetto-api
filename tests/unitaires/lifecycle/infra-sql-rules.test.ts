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
 *
 * A denylist of words missed the other ways to lock a role out (VALID
 * UNTIL, CONNECTION LIMIT 0, a REVOKE CONNECT on the database) and a
 * statement glued from string pieces (`'ALTER ROLE ' || r || ' PASSWORD '`).
 * So an ALTER ROLE is held to what a step needs (SET, RESET, and the NO…
 * attributes that only take powers away), the database itself is out of
 * bounds but for SET and RESET, and every rule reads the code with its
 * string literals opened up.
 */
const ROOT = process.cwd();

/** The SQL with comments removed; literals and $$ bodies kept (EXECUTE '...'). */
function codeOf(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * The code with its string literals opened up: the quotes and the `||`
 * that glue the pieces of a dynamic statement taken out, so
 * `'ALTER ROLE ' || quote_ident(r) || ' PASSWORD ' || p` reads as the
 * statement it runs. A literal that only mentions a keyword (a NOTICE) is
 * then read as code too: reword it.
 */
function flatOf(code: string): string {
  return code.replace(/\|\|/g, " ").replace(/'/g, " ");
}

/**
 * A role or database as a step names it: an identifier, a quoted one, a
 * format() placeholder (%I) or the call that quotes it (quote_ident(r)).
 */
const NAME = String.raw`(?:"(?:[^"]|"")+"|%(?:\d+\$)?[IsL]|[A-Za-z_][\w$.]*(?:\s*\([^()]*\))?)`;

/**
 * The only ALTER ROLE a step may run: a setting (SET, RESET, also IN
 * DATABASE), or attributes that only take powers away. Anything else
 * (LOGIN, NOLOGIN, PASSWORD, VALID UNTIL, CONNECTION LIMIT, RENAME,
 * INHERIT, an attribute from a variable) is the owner's, by hand.
 */
const ALLOWED_ALTER_ROLE = new RegExp(
  String.raw`^\s+${NAME}\s+(?:(?:IN\s+DATABASE\s+${NAME}\s+)?(?:SET|RESET)\b|(?:WITH\s+)?(?:NO(?:SUPERUSER|CREATEDB|CREATEROLE|REPLICATION|BYPASSRLS)\b\s*)+(?=[;,)]|$))`,
  "i",
);

const ALLOWED_ALTER_DATABASE = new RegExp(
  String.raw`^\s+${NAME}\s+(?:SET|RESET)\b`,
  "i",
);

/** The dollar-quoted bodies of a script: `DO $$ ... $$`, functions. */
function dollarBlocks(code: string): string[] {
  return [...code.matchAll(/\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1\$/g)].map(
    (match) => match[2],
  );
}

/** Read on the opened-up code (flatOf): up to the statement's end. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [
    /\bALTER\s+(?:ROLE|USER)\b[^;]*\b(?:NO)?LOGIN\b/i,
    "ALTER ROLE com LOGIN/NOLOGIN",
  ],
  [/\bALTER\s+(?:ROLE|USER)\b[^;]*\bPASSWORD\b/i, "ALTER ROLE com PASSWORD"],
  // The runtime's connection, refused at the door: the database's CONNECT
  // taken away, or every grant of a role dropped with it.
  [/\bREVOKE\b[^;]*\bON\s+DATABASE\b/i, "REVOKE no DATABASE (CONNECT)"],
  [/\bDROP\s+OWNED\b/i, "DROP OWNED"],
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
  [/\b(?:CREATE|ALTER)\s+ROLE\b[^;]*\bSUPERUSER\b/i, "role com SUPERUSER"],
  [
    /\bpg_(?:execute_server_program|read_server_files|write_server_files)\b/i,
    "role que roda programa ou lê arquivo do servidor",
  ],
  [
    /\b(?:lo_import|lo_export|pg_read_file|pg_read_binary_file)\b/i,
    "função que lê ou grava arquivo do servidor",
  ],
];

const ALTER_ROLE_OUTSIDE =
  "ALTER ROLE fora de SET, RESET e NO… (login, senha, validade, limite de conexões e nome são do dono)";

/** The rules of one infra/sql (or post-deploy) file. */
function stepProblems(name: string, sql: string): string[] {
  const code = codeOf(sql);
  const flat = flatOf(code);
  const problems: string[] = [];

  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(flat)) problems.push(`${name}: ${what}`);
  }

  for (const [, rest] of flat.matchAll(/\bALTER\s+ROLE\b([^;]*)/gi)) {
    if (!ALLOWED_ALTER_ROLE.test(rest)) {
      problems.push(`${name}: ${ALTER_ROLE_OUTSIDE}`);
      break;
    }
  }

  for (const [, rest] of flat.matchAll(/\bALTER\s+DATABASE\b([^;]*)/gi)) {
    if (!ALLOWED_ALTER_DATABASE.test(rest)) {
      problems.push(`${name}: ALTER DATABASE fora de SET e RESET`);
      break;
    }
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

  it.each([
    [
      "an expiry date",
      `${GOOD}\nALTER ROLE trajetto_app VALID UNTIL '2000-01-01';`,
      `10-x.sql: ${ALTER_ROLE_OUTSIDE}`,
    ],
    [
      "no connections at all",
      `${GOOD}\nALTER ROLE trajetto CONNECTION LIMIT 0;`,
      `10-x.sql: ${ALTER_ROLE_OUTSIDE}`,
    ],
    [
      "a new name",
      `${GOOD}\nALTER ROLE trajetto RENAME TO trajetto_old;`,
      `10-x.sql: ${ALTER_ROLE_OUTSIDE}`,
    ],
    [
      "a password glued from string pieces",
      `${GOOD}\nDO $$ DECLARE r text := 'trajetto'; p text := 'x'; BEGIN EXECUTE 'ALTER ROLE ' || quote_ident(r) || ' PASSWORD ' || quote_literal(p); END $$;`,
      "10-x.sql: ALTER ROLE com PASSWORD",
    ],
    [
      "an attribute that comes from a variable",
      `${GOOD}\nDO $$ DECLARE attr text := 'NOLOGIN'; BEGIN EXECUTE format('ALTER ROLE %I %s', 'trajetto', attr); END $$;`,
      `10-x.sql: ${ALTER_ROLE_OUTSIDE}`,
    ],
    [
      "the database's CONNECT taken away",
      `${GOOD}\nREVOKE CONNECT ON DATABASE trajetto FROM PUBLIC;`,
      "10-x.sql: REVOKE no DATABASE (CONNECT)",
    ],
    [
      "every grant of a role dropped",
      `${GOOD}\nDROP OWNED BY trajetto_app;`,
      "10-x.sql: DROP OWNED",
    ],
    [
      "the database closed to connections",
      `${GOOD}\nALTER DATABASE trajetto ALLOW_CONNECTIONS false;`,
      "10-x.sql: ALTER DATABASE fora de SET e RESET",
    ],
  ])("refuse what locks the runtime out: %s", (_case, sql, problem) => {
    expect(stepProblems("10-x.sql", sql)).toContain(problem);
  });

  it("accept the settings a step keeps on a role or on the database", () => {
    expect(
      stepProblems(
        "10-x.sql",
        [
          GOOD,
          "ALTER ROLE trajetto_app SET statement_timeout = '30s';",
          "ALTER ROLE trajetto_app IN DATABASE trajetto RESET work_mem;",
          "ALTER ROLE trajetto_batch WITH NOCREATEDB NOCREATEROLE;",
          "ALTER DATABASE trajetto SET work_mem = '8MB';",
          "DO $$ BEGIN EXECUTE format('ALTER ROLE %I SET %I = %L', 'trajetto_app', 'lock_timeout', '5s'); END $$;",
        ].join("\n"),
      ),
    ).toEqual([]);
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
