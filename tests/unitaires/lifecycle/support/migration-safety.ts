import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The expand/contract rule for prisma/migrations, as code (INFRA-05).
 *
 * Migrations run while the PREVIOUS image is still serving: at the boot of the
 * new task in a start-first rollout, or in the release job right before it —
 * and again after an automatic rollback, which brings the old image back over
 * the new schema. The old Prisma client names every scalar column in its
 * SELECT and RETURNING, and inserts without the columns it does not know. So a
 * statement that removes, renames, retypes or tightens something the previous
 * release reads or writes breaks it (P2022, NOT NULL violations) for the whole
 * rollout, and for good after a rollback.
 *
 * Such a statement is accepted only when:
 *  - its table or type was created after the production baseline, so no
 *    running image has ever touched it; or
 *  - the file says why it is safe: `-- contract-phase: <why>` (the release that
 *    stopped reading it is already the one in production), or, for a new enum
 *    value, `-- enum-expand: <why>` (no running image reads rows carrying it),
 *    or, for a column made optional, `-- nullable-expand: <why>` (nothing
 *    writes a NULL there while an image that requires it still runs).
 */

interface Violation {
  migration: string;
  rule: string;
  target: string;
  statement: string;
}

interface Rule {
  name: string;
  matches: (statement: string) => boolean;
  /** Markers that accept the statement, as `-- <marker>: <reason>`. */
  markers: string[];
}

const IDENTIFIER = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?`;

/** `"public"."User"` → `User`; `public.user_x` → `user_x` (unquoted folds). */
function objectName(raw: string): string {
  const last = raw.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/).pop() ?? raw;

  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/**
 * The SQL with comments removed and string literals blanked, plus the bodies
 * of dollar-quoted blocks (DO $$ ... $$), which are returned apart and kept
 * with their literals: dynamic DDL lives inside `EXECUTE '...'`.
 */
function scan(
  sql: string,
  keepLiterals = false,
): { code: string; blocks: string[] } {
  let code = "";
  const blocks: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      code += " ";
      i = end < 0 ? sql.length : end + 2;
      continue;
    }

    if (char === "'") {
      let j = i + 1;

      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }

      code += keepLiterals ? sql.slice(i, j + 1) : "''";
      i = j + 1;
      continue;
    }

    if (char === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      code += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === "$") {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];

      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        blocks.push(sql.slice(i + tag.length, end < 0 ? sql.length : end));
        code += " $block$ ";
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }

    code += char;
    i += 1;
  }

  return { code, blocks };
}

function statementsOf(code: string): string[] {
  return code
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Top-level comma split: `NUMERIC(10,2)` is one clause, not two. */
function clausesOf(statement: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < statement.length; i += 1) {
    if (statement[i] === "(") depth += 1;
    else if (statement[i] === ")") depth -= 1;
    else if (statement[i] === "," && depth === 0) {
      clauses.push(statement.slice(start, i));
      start = i + 1;
    }
  }

  clauses.push(statement.slice(start));

  return clauses;
}

function addsRequiredColumnWithoutDefault(statement: string): boolean {
  if (!/^ALTER\s+TABLE\b/i.test(statement)) return false;

  return clausesOf(statement).some(
    (clause) =>
      /\bADD\s+COLUMN\b/i.test(clause) &&
      /\bNOT\s+NULL\b/i.test(clause) &&
      !/\bDEFAULT\b/i.test(clause) &&
      !/\bGENERATED\b/i.test(clause),
  );
}

const CONTRACT = ["contract-phase"];

const RULES: Rule[] = [
  {
    name: "DROP COLUMN",
    matches: (s) => /\bDROP\s+COLUMN\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "DROP TABLE",
    matches: (s) => /\bDROP\s+TABLE\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "DROP TYPE",
    matches: (s) => /\bDROP\s+TYPE\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "RENAME COLUMN",
    matches: (s) => /\bRENAME\s+COLUMN\b/i.test(s),
    markers: CONTRACT,
  },
  {
    // An index is never named by the client: renaming one is harmless.
    name: "RENAME TO",
    matches: (s) => /\bRENAME\s+TO\b/i.test(s) && !/^ALTER\s+INDEX\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "RENAME VALUE",
    matches: (s) => /\bRENAME\s+VALUE\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "ALTER COLUMN ... TYPE",
    matches: (s) =>
      new RegExp(
        String.raw`\bALTER\s+COLUMN\s+${IDENTIFIER}\s+(?:SET\s+DATA\s+)?TYPE\b`,
        "i",
      ).test(s),
    markers: CONTRACT,
  },
  {
    name: "SET NOT NULL",
    matches: (s) => /\bSET\s+NOT\s+NULL\b/i.test(s),
    markers: CONTRACT,
  },
  {
    // Loosening, but the previous client still reads the column as required
    // and throws (P2032) on the first NULL the new release writes: the same
    // two-release rule as a new enum value.
    name: "DROP NOT NULL",
    matches: (s) => /\bDROP\s+NOT\s+NULL\b/i.test(s),
    markers: ["nullable-expand", ...CONTRACT],
  },
  {
    name: "ADD COLUMN ... NOT NULL without DEFAULT",
    matches: addsRequiredColumnWithoutDefault,
    markers: CONTRACT,
  },
  {
    name: "DELETE FROM",
    matches: (s) => /\bDELETE\s+FROM\b/i.test(s),
    markers: CONTRACT,
  },
  {
    name: "TRUNCATE",
    matches: (s) => /\bTRUNCATE\b/i.test(s),
    markers: CONTRACT,
  },
  {
    // Additive for the schema, but the previous client throws on reading a
    // value its enum does not have: write it only in a later release.
    name: "ALTER TYPE ... ADD VALUE",
    matches: (s) => /^ALTER\s+TYPE\b.*\bADD\s+VALUE\b/i.test(s),
    markers: ["enum-expand", ...CONTRACT],
  },
];

/** The table or type a statement acts on, or null when it cannot be told. */
function targetOf(statement: string): string[] | null {
  const patterns = [
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`,
    String.raw`^ALTER\s+TYPE\s+(${QUALIFIED})`,
    String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?(${QUALIFIED})`,
  ];

  for (const pattern of patterns) {
    const match = new RegExp(pattern, "i").exec(statement);
    if (match) return [objectName(match[1])];
  }

  // DROP TABLE / DROP TYPE / TRUNCATE take a list.
  const list = new RegExp(
    String.raw`^(?:DROP\s+(?:TABLE|TYPE)\s+(?:IF\s+EXISTS\s+)?|TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?)(${QUALIFIED}(?:\s*,\s*${QUALIFIED})*)`,
    "i",
  ).exec(statement);

  if (list) return list[1].split(",").map((name) => objectName(name.trim()));

  return null;
}

function createdBy(statement: string): string | null {
  const match = new RegExp(
    String.raw`^CREATE\s+(?:UNLOGGED\s+)?(?:TABLE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
    "i",
  ).exec(statement);

  return match ? objectName(match[1]) : null;
}

function hasMarker(sql: string, markers: string[]): boolean {
  // Same line only: `[ \t]`, not `\s`, or an empty marker would borrow the
  // next line's text as its reason.
  return markers.some((marker) =>
    new RegExp(String.raw`^[ \t]*--[ \t]*${marker}:[ \t]*\S`, "im").test(sql),
  );
}

/**
 * Every statement of `migrations` (name → SQL, applied in name order after
 * the baseline) that the previous release could not live with.
 */
function violationsIn(
  migrations: Array<{ name: string; sql: string }>,
): Violation[] {
  const created = new Set<string>();
  const violations: Violation[] = [];

  for (const { name, sql } of [...migrations].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const { code, blocks } = scan(sql);

    const checked = [
      ...statementsOf(code).map((statement) => ({ statement, inBlock: false })),
      // Inside DO blocks the target is dynamic: never exempt by creation.
      ...blocks.flatMap((block) =>
        statementsOf(scan(block, true).code).map((statement) => ({
          statement,
          inBlock: true,
        })),
      ),
    ];

    for (const { statement, inBlock } of checked) {
      for (const rule of RULES) {
        if (!rule.matches(statement)) continue;

        const targets = inBlock ? null : targetOf(statement);
        const isNew =
          targets !== null && targets.every((target) => created.has(target));

        if (isNew || hasMarker(sql, rule.markers)) continue;

        violations.push({
          migration: name,
          rule: rule.name,
          target: targets?.join(", ") ?? "?",
          statement: statement.slice(0, 160),
        });
      }

      const newObject = inBlock ? null : createdBy(statement);
      if (newObject) created.add(newObject);
    }
  }

  return violations;
}

/** The migration directories of `dir` after `baseline`, with their SQL. */
function migrationsAfter(
  dir: string,
  baseline: string,
): Array<{ name: string; sql: string }> {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name > baseline)
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(dir, entry.name, "migration.sql"), "utf8"),
    }));
}

function describeViolation(violation: Violation): string {
  return `${violation.migration}: ${violation.rule} em ${violation.target} — ${violation.statement}`;
}

export { describeViolation, migrationsAfter, violationsIn, type Violation };
