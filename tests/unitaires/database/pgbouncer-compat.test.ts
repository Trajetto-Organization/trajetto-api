import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  NEGATIVE_SHELL,
  NEGATIVE_SOURCE,
  POSITIVE_SOURCES,
} from "./fixtures/pgbouncer-compat-fixtures";

/**
 * Nothing the API runs may need a session of its own (plano-escala F4-30).
 *
 * From wave 17 the Applications reach Postgres through PgBouncer in
 * transaction mode: each transaction may run on a different server
 * connection, and whatever a statement leaves on the session outlives it
 * there, for the next client. So these break, silently:
 *
 *  - LISTEN/UNLISTEN: the notification arrives on a connection nobody
 *    listens on;
 *  - session advisory locks (pg_advisory_lock, pg_try_advisory_lock, their
 *    unlock): held by a connection that goes back to the pool;
 *    pg_advisory_xact_lock is fine;
 *  - SET without LOCAL (and set_config(…, false)): the setting stays on
 *    the server connection for whoever borrows it next. SET LOCAL,
 *    SET TRANSACTION and SET CONSTRAINTS live and die with the transaction;
 *  - PREPARE, WITH HOLD cursors, CREATE TEMP and DISCARD: objects or resets
 *    of a session the next transaction may not get back.
 *
 * The SET rule is anchored at the START of a statement inside an SQL
 * string: a naive search for "SET" without LOCAL failed on every UPDATE
 * and on ON CONFLICT … DO UPDATE SET (support-ticket-repository.ts). The
 * statement rules also want the statement's shape (LISTEN a channel,
 * PREPARE … AS), so prose in a string ("listen to the driver") is not SQL.
 *
 * What is read: the string and template literals of every .ts/.js file
 * under src/ and infra/ (by the TypeScript parser, so comments never
 * count), the quoted strings and heredocs of the shell scripts, and the
 * .sql files. Python under infra/ai-ocr never connects to the database.
 *
 * The exceptions are the connections that never go through PgBouncer and
 * need a session on purpose, listed in DDL_CONNECTION_ALLOWLIST: the
 * release step's own (CREATE INDEX CONCURRENTLY and the idempotent steps,
 * F2-01/F5-08, whose session SETs bound each step; release-connection.ts
 * refuses a URL through PgBouncer) and the dedicated DDL connection of the
 * partition job (F2-08/F3-20), which runs DETACH … CONCURRENTLY outside a
 * transaction with a session SET ROLE.
 */
const ROOT = process.cwd();
const SCANNED_DIRS = ["src", "infra"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/** Files allowed a session: direct connections that refuse PgBouncer. */
const DDL_CONNECTION_ALLOWLIST: string[] = [
  "infra/scripts/online-ddl.ts",
  "infra/scripts/release-connection.ts",
  "infra/scripts/release-step-runner.ts",
];

interface Finding {
  file: string;
  line: number;
  rule: string;
  statement: string;
}

interface SqlText {
  text: string;
  line: number;
}

/** Rules for the start of one statement, after its comments are gone. */
const STATEMENT_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    rule: "listen",
    pattern: /^(UN)?LISTEN\s+("[^"]+"|[A-Za-z_][\w$]*|\*)\s*$/i,
  },
  {
    rule: "session-set",
    pattern:
      /^SET\s+(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)(SESSION\s+)?(ROLE\b|TIME\s+ZONE\b|SCHEMA\b|NAMES\b|AUTHORIZATION\b|SESSION\s+AUTHORIZATION\b|"?[A-Za-z_][\w.$]*"?\s*(=|TO\b))/i,
  },
  {
    rule: "prepare",
    pattern: /^PREPARE\s+[A-Za-z_][\w$]*\s*(\([^)]*\)\s*)?AS\s/i,
  },
  {
    rule: "discard",
    pattern: /^DISCARD\s+(ALL|PLANS|SEQUENCES|TEMP|TEMPORARY)\s*$/i,
  },
];

/** Rules for anywhere in an SQL text. */
const ANYWHERE_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    rule: "session-advisory-lock",
    pattern: /\bpg_(try_)?advisory_(lock|unlock)(_shared|_all)?\s*\(/i,
  },
  { rule: "with-hold", pattern: /\bWITH\s+HOLD\b/i },
  {
    rule: "create-temp",
    pattern: /\bCREATE\s+((GLOBAL|LOCAL)\s+)?TEMP(ORARY)?\s+TABLE\b/i,
  },
  {
    rule: "session-set-config",
    pattern: /\bset_config\s*\([^)]*,\s*false\s*\)/i,
  },
];

/** The SQL without its comments: `--` to the end of line, and blocks. */
function withoutSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function findingsIn(file: string, sql: SqlText): Finding[] {
  const findings: Finding[] = [];
  const text = withoutSqlComments(sql.text);

  for (const statement of text.split(";")) {
    const start = statement.trim();

    for (const { rule, pattern } of STATEMENT_RULES) {
      if (pattern.test(start)) {
        findings.push({
          file,
          line: sql.line,
          rule,
          statement: start.slice(0, 80),
        });
      }
    }
  }

  for (const { rule, pattern } of ANYWHERE_RULES) {
    const match = pattern.exec(text);

    if (match) {
      findings.push({
        file,
        line: sql.line,
        rule,
        statement: match[0],
      });
    }
  }

  return findings;
}

/**
 * Every string and template literal, by the parser: a template's
 * substitutions become a placeholder, as the driver sends them.
 */
function codeStrings(file: string, text: string): SqlText[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const strings: SqlText[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push({ text: node.text, line: lineOf(node) });
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];

      for (const span of node.templateSpans) {
        parts.push("$1", span.literal.text);
      }

      strings.push({ text: parts.join(""), line: lineOf(node) });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return strings;
}

/**
 * A shell script's quoted strings and heredoc bodies; comments and the
 * shell's own words (`set -eu`) are not SQL.
 */
function shellStrings(text: string): SqlText[] {
  const strings: SqlText[] = [];
  const lines = text.split("\n");
  let heredoc: { end: string; body: string[]; line: number } | null = null;

  lines.forEach((raw, index) => {
    if (heredoc) {
      if (raw.trim() === heredoc.end) {
        strings.push({ text: heredoc.body.join("\n"), line: heredoc.line });
        heredoc = null;
      } else {
        heredoc.body.push(raw);
      }
      return;
    }

    const line = raw.replace(/(^|\s)#.*$/, "$1");

    for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      strings.push({ text: match[1] ?? match[2] ?? "", line: index + 1 });
    }

    const start = /<<-?\s*['"]?([A-Za-z_]+)['"]?/.exec(line);

    if (start) heredoc = { end: start[1], body: [], line: index + 2 };
  });

  return strings;
}

function scanSource(file: string, text: string): Finding[] {
  const extension = extname(file);
  const sqlTexts = CODE_EXTENSIONS.has(extension)
    ? codeStrings(file, text)
    : extension === ".sh"
      ? shellStrings(text)
      : extension === ".sql"
        ? [{ text, line: 1 }]
        : [];

  return sqlTexts.flatMap((sql) => findingsIn(file, sql));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (name === "node_modules") return [];

    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Every scanned file of src/ and infra/, relative and with forward slashes. */
function scannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => filesUnder(resolve(ROOT, dir)))
    .map((path) => relative(ROOT, path).replace(/\\/g, "/"))
    .filter((file) => !DDL_CONNECTION_ALLOWLIST.includes(file));
}

describe("PgBouncer in transaction mode", () => {
  it("finds nothing that needs a session in src/ and infra/", () => {
    const findings = scannedFiles().flatMap((file) =>
      scanSource(file, readFileSync(resolve(ROOT, file), "utf8")),
    );

    expect(findings).toEqual([]);
  });

  it("reads the real SQL: the upsert's DO UPDATE SET and the SET LOCAL", () => {
    // Proof the scan sees the strings it lets through, not an empty tree.
    function stringsOf(file: string): string[] {
      const text = readFileSync(resolve(ROOT, file), "utf8");

      return codeStrings(file, text).map((sql) => sql.text);
    }

    const upsert = stringsOf(
      "src/modules/chat/repositories/support-ticket-repository.ts",
    );
    const backfill = stringsOf("src/shared/delivery/address-key-backfill.ts");

    expect(upsert).toContainEqual(expect.stringContaining("DO UPDATE SET"));
    expect(backfill).toContain("SET LOCAL lock_timeout = '5s'");
    expect(scannedFiles().length).toBeGreaterThan(500);
  });

  it.each(POSITIVE_SOURCES.map((source) => [source.file, source] as const))(
    "catches a planted %s",
    (_name, source) => {
      const rules = scanSource(source.file, source.text).map((f) => f.rule);

      expect(rules).toEqual([source.rule]);
    },
  );

  it("lets the look-alikes through: UPDATE … SET, DO UPDATE SET, SET LOCAL, xact locks", () => {
    expect(scanSource(NEGATIVE_SOURCE.file, NEGATIVE_SOURCE.text)).toEqual([]);
    expect(scanSource(NEGATIVE_SHELL.file, NEGATIVE_SHELL.text)).toEqual([]);
  });

  it("allows only files that exist on the DDL connection's list", () => {
    for (const file of DDL_CONNECTION_ALLOWLIST) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(true);
    }
  });
});
