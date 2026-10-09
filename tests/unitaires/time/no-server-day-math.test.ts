import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { BRAZILIAN_TIME_ZONES } from "@/shared/time/business-day";

/**
 * No "day" computed from the server's clock (decision 1.2, CRIT-8).
 *
 * The container runs in UTC on purpose (date-only columns are UTC midnight),
 * so the server's calendar is the wrong one for every company: its midnight is
 * 21:00 in São Paulo and 20:00 in Manaus. A business day comes from
 * shared/time/business-day with `Business.timezone`. This scan reads every
 * source file's syntax tree (comments do not count) and refuses:
 *
 * - `x.setHours(0, …)` / `x.setHours(23, …)`: the server's midnight or end of
 *   day;
 * - `x.setUTCHours(0, …)` / `x.setUTCHours(23, …)`: UTC's midnight, which is
 *   21:00 in São Paulo;
 * - `x.toISOString().slice(0, 10)` (or `.substring`/`.substr`/`.split("T")[0]`):
 *   the UTC day used as a date;
 * - the server's calendar read or moved: `getFullYear`, `getMonth`,
 *   `getDate`, `getDay`, `setFullYear`, `setMonth`, `setDate` (UTC in the
 *   container, São Paulo on a developer machine: tests pass, production drifts);
 * - a Brazilian zone written as a literal (`"America/Sao_Paulo"`) outside
 *   shared/time: the company's zone is `Business.timezone`. An object key
 *   (a zone's display name) is not a use of the zone;
 * - an instant printed in the server's zone: `new Intl.DateTimeFormat(…)`,
 *   `x.toLocaleDateString(…)` or `x.toLocaleTimeString(…)` without a
 *   `timeZone` option, and `x.toLocaleString(…)` with date options but no
 *   `timeZone` (a number's toLocaleString has no date options). After 21:00
 *   in São Paulo the container prints tomorrow. Options passed as a variable
 *   or with a spread cannot be read here and are not judged.
 *
 * Two lists say where one is allowed. ALLOWED holds the real UTC (or purely
 * cosmetic) contexts, each with its reason. PENDING holds the offenders other
 * packages still owe (the final integration fixes them); it may only shrink —
 * an entry that no longer matches fails the second test, so whoever fixes an
 * offender deletes (or lowers) its entry here in the same change.
 */

type Pattern =
  | "server-midnight"
  | "utc-midnight"
  | "utc-day-key"
  | "server-calendar"
  | "hardcoded-zone"
  | "server-zone-format";

interface Entry {
  file: string;
  pattern: Pattern;
  count: number;
  reason: string;
}

const ALLOWED: Entry[] = [
  {
    file: "src/shared/time/business-day.ts",
    pattern: "utc-day-key",
    count: 2,
    reason:
      "dateOnlyFromKey/dateOnlyKey: a date-only column (@db.Date) IS the UTC day of its value.",
  },
  {
    file: "src/jobs/cron/driver-position-partitions-job.ts",
    pattern: "utc-day-key",
    count: 1,
    reason: "Partition names follow the partitions' own UTC day bounds, not a company's day.",
  },
  {
    file: "src/jobs/cron/driver-position-partitions-job.ts",
    pattern: "utc-midnight",
    count: 1,
    reason: "A partition covers one UTC day; its bounds are UTC midnights by design.",
  },
  {
    file: "src/shared/notifications/notification-pipeline-service.ts",
    pattern: "server-calendar",
    count: 2,
    reason: "Copyright year in the e-mail footer: cosmetic, never a business day.",
  },
  {
    file: "src/shared/services/transactional-mail-service.ts",
    pattern: "server-calendar",
    count: 1,
    reason: "Copyright year in the e-mail footer: cosmetic, never a business day.",
  },
  {
    file: "src/routes/documentation/response-examples.ts",
    pattern: "hardcoded-zone",
    count: 1,
    reason: "Swagger example of my-deliveries' journey.time_zone: sample data, never read as a zone.",
  },
];

/**
 * Offenders owned by other packages (listed in the dash-time cross notes).
 * Whoever fixes one deletes or lowers its entry in the same change: a stale
 * entry fails the second test on purpose, so the list cannot hide new debt.
 */
const pending = (
  file: string,
  pattern: Pattern,
  owner: string,
  what: string,
  count = 1,
): Entry => ({ file, pattern, count, reason: `${owner}: ${what}` });

// Empty since the final integration (29/09/2026): the service-order card's due
// date, the export date columns and the notifications' formatDate now read
// the company's zone. A new offender goes here only with an owner and a
// reason, and leaves in the change that fixes it.
const PENDING: Entry[] = [];

const ROOT = join(__dirname, "..", "..", "..");
const SOURCE = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

function methodName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;

  const callee = node.expression;

  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function isToIsoStringCall(node: ts.Node): boolean {
  return methodName(node) === "toISOString";
}

function receiverOf(call: ts.CallExpression): ts.Expression {
  return (call.expression as ts.PropertyAccessExpression).expression;
}

// Local-calendar getters and setters: they read the process zone.
const SERVER_CALENDAR = new Set([
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "setFullYear",
  "setMonth",
  "setDate",
]);

const ZONES: ReadonlySet<string> = new Set(BRAZILIAN_TIME_ZONES);

/** shared/time is where the zones are defined; nowhere else names one. */
function definesZones(file: string): boolean {
  return file.split(sep).join("/").includes("src/shared/time/");
}

function isPropertyName(node: ts.Node): boolean {
  return (
    (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
    node.parent.name === node
  );
}

// Options that make a toLocaleString call a date format, not a number one.
const DATE_OPTIONS = new Set([
  "dateStyle",
  "timeStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "timeZoneName",
]);

/**
 * How a formatting call's options argument reads: "zoned" with a timeZone,
 * "unknown" when it is not an object literal (or spreads one), otherwise the
 * keys it names (empty when there is no options argument).
 */
function formatOptions(
  args: ts.NodeArray<ts.Expression> | undefined,
  index: number,
): "zoned" | "unknown" | Set<string> {
  const arg = args?.[index];

  if (!arg) return new Set();
  if (!ts.isObjectLiteralExpression(arg)) return "unknown";

  const keys = new Set<string>();

  for (const property of arg.properties) {
    if (ts.isSpreadAssignment(property)) return "unknown";

    const name = property.name && ts.isIdentifier(property.name) ? property.name.text : null;

    if (name) keys.add(name);
  }

  return keys.has("timeZone") ? "zoned" : keys;
}

function isDateTimeFormatConstructor(node: ts.Node): node is ts.NewExpression {
  if (!ts.isNewExpression(node)) return false;

  const callee = node.expression;

  return (
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "DateTimeFormat" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Intl") ||
    (ts.isIdentifier(callee) && callee.text === "DateTimeFormat")
  );
}

function numberAt(args: ts.NodeArray<ts.Expression>, index: number): number | null {
  const arg = args[index];

  return arg && ts.isNumericLiteral(arg) ? Number(arg.text) : null;
}

/** Every offending node of a source text, with its pattern and line. */
function offenders(
  file: string,
  text: string = readFileSync(file, "utf8"),
): Array<{ pattern: Pattern; line: number; text: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ pattern: Pattern; line: number; text: string }> = [];

  const report = (node: ts.Node, pattern: Pattern) => {
    found.push({
      pattern,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      text: node.getText().replace(/\s+/g, " ").slice(0, 120),
    });
  };

  const visit = (node: ts.Node) => {
    const name = methodName(node);

    if (name === "setHours" || name === "setUTCHours") {
      const hour = numberAt((node as ts.CallExpression).arguments, 0);

      if (hour === 0 || hour === 23) {
        report(node, name === "setHours" ? "server-midnight" : "utc-midnight");
      }
    }

    if (name && SERVER_CALENDAR.has(name)) report(node, "server-calendar");

    if (isDateTimeFormatConstructor(node)) {
      if (formatOptions(node.arguments, 1) instanceof Set) {
        report(node, "server-zone-format");
      }
    }

    if (name === "toLocaleDateString" || name === "toLocaleTimeString") {
      if (formatOptions((node as ts.CallExpression).arguments, 1) instanceof Set) {
        report(node, "server-zone-format");
      }
    }

    if (name === "toLocaleString") {
      const options = formatOptions((node as ts.CallExpression).arguments, 1);

      if (options instanceof Set && [...options].some((key) => DATE_OPTIONS.has(key))) {
        report(node, "server-zone-format");
      }
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ZONES.has(node.text) &&
      !isPropertyName(node) &&
      !definesZones(file)
    ) {
      report(node, "hardcoded-zone");
    }

    if (
      (name === "slice" || name === "substring" || name === "substr") &&
      isToIsoStringCall(receiverOf(node as ts.CallExpression))
    ) {
      const args = (node as ts.CallExpression).arguments;

      if (numberAt(args, 0) === 0 && numberAt(args, 1) === 10) {
        report(node, "utc-day-key");
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isNumericLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "0" &&
      methodName(node.expression) === "split"
    ) {
      const split = node.expression as ts.CallExpression;
      const separator = split.arguments[0];

      if (
        separator &&
        ts.isStringLiteral(separator) &&
        separator.text === "T" &&
        isToIsoStringCall(receiverOf(split))
      ) {
        report(node, "utc-day-key");
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function scan() {
  return sourceFiles(SOURCE).flatMap((path) =>
    offenders(path).map((hit) => ({
      ...hit,
      file: relative(ROOT, path).split(sep).join("/"),
    })),
  );
}

function counted(hits: ReturnType<typeof scan>): Map<string, number> {
  const counts = new Map<string, number>();

  for (const hit of hits) {
    const key = `${hit.file}::${hit.pattern}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

describe("server-day math in the API", () => {
  const hits = scan();
  const counts = counted(hits);
  const listed = [...ALLOWED, ...PENDING];

  it("finds none outside the allowed UTC contexts and the known debts", () => {
    const unexpected = [...counts.entries()].filter(([key, count]) => {
      const entry = listed.find((item) => `${item.file}::${item.pattern}` === key);

      return !entry || count > entry.count;
    });

    const detail = unexpected.flatMap(([key]) =>
      hits
        .filter((hit) => `${hit.file}::${hit.pattern}` === key)
        .map((hit) => `${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`),
    );

    expect(
      detail,
      "use shared/time/business-day com o fuso da empresa (Business.timezone)",
    ).toEqual([]);
  });

  it("keeps the lists honest: every entry still matches as many times as listed", () => {
    const stale = listed
      .filter((entry) => (counts.get(`${entry.file}::${entry.pattern}`) ?? 0) < entry.count)
      .map((entry) => `${entry.file} [${entry.pattern}] ×${entry.count}`);

    expect(stale, "corrigido? apague ou reduza a entrada").toEqual([]);
  });

  it("really sees the patterns it refuses, and only in code", () => {
    // A scan that found nothing would pass the first test on any code.
    const probe = offenders(
      "probe.ts",
      [
        "// startOfToday.setHours(0, 0, 0, 0) in a comment is fine",
        'const note = "toISOString().slice(0, 10)";',
        "const start = new Date(); start.setHours(0, 0, 0, 0);",
        "const end = new Date(); end.setHours(23, 59, 59, 999);",
        "const key = new Date().toISOString().slice(0, 10);",
        'const file = new Date().toISOString().split("T")[0];',
        "const month = new Date(now.getFullYear(), now.getMonth(), 1);",
        "const noon = new Date(); noon.setHours(12);",
        "const due = new Date(last); due.setMonth(due.getMonth() + 6);",
        "const day = new Date(); day.setUTCHours(0, 0, 0, 0);",
        "const hour = new Date(); hour.setUTCHours(12);",
        'const zone = "America/Sao_Paulo";',
        'const names = { "America/Manaus": "Manaus" };',
        "const label = `America/Cuiaba`;",
        "const utc = now.getUTCDate();",
        'const text = "fuso America/Sao_Paulo por padrão";',
        'const a = new Intl.DateTimeFormat("pt-BR").format(now);',
        'const b = new Intl.DateTimeFormat("pt-BR", { timeZone: zone }).format(now);',
        'const c = now.toLocaleDateString("pt-BR");',
        'const d = now.toLocaleTimeString("pt-BR", { hour: "2-digit", timeZone: "UTC" });',
        'const e = now.toLocaleString("pt-BR", { day: "2-digit", hour: "2-digit" });',
        'const f = total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });',
        'const g = now.toLocaleDateString("pt-BR", options);',
      ].join("\n"),
    );

    expect(probe.map((hit) => [hit.line, hit.pattern])).toEqual([
      [3, "server-midnight"],
      [4, "server-midnight"],
      [5, "utc-day-key"],
      [6, "utc-day-key"],
      [7, "server-calendar"],
      [7, "server-calendar"],
      [9, "server-calendar"],
      [9, "server-calendar"],
      [10, "utc-midnight"],
      [12, "hardcoded-zone"],
      [14, "hardcoded-zone"],
      [17, "server-zone-format"],
      [19, "server-zone-format"],
      [21, "server-zone-format"],
    ]);
  });

  it("lets shared/time name the zones it defines", () => {
    expect(
      offenders("src/shared/time/probe.ts", 'const zone = "America/Sao_Paulo";'),
    ).toEqual([]);
  });
});
