import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every URL a client builds has a route to land on.
 *
 * The cross-tenant fix moved DELETE /fines/delete-fine/:fineId to
 * /fines/delete-fine/:fineId/business/:businessId, and the web kept calling
 * the old path: deleting a fine answered 404 "Route … not found" and the fine
 * stayed, with every test on both sides green. Nothing compared what the
 * clients call with what the API serves.
 *
 * Path shapes only — `${anything}` stands for one segment — read from the
 * sibling checkouts when they are there. It is a floor, not a full contract:
 * the method and the body are not compared.
 */
const API_ROOT = process.cwd();

interface Route {
  path: string;
  pattern: RegExp;
}

function apiRoutes(): Route[] {
  const routesDir = resolve(API_ROOT, "src", "routes");
  const root = readFileSync(join(routesDir, "routes.ts"), "utf8");

  const imports = new Map<string, string>();

  for (const match of root.matchAll(
    /import\s+\{?\s*([A-Za-z]+)[^;]*?from\s+"\.\/([^"]+)"/g,
  )) {
    imports.set(match[1], match[2]);
  }

  const routes: Route[] = [];

  for (const match of root.matchAll(
    /register\(\s*([A-Za-z]+)\s*(?:,\s*\{\s*prefix:\s*"([^"]*)"\s*\})?\s*\)/g,
  )) {
    const file = imports.get(match[1]);
    if (!file) continue;

    const source = readFileSync(join(routesDir, `${file}.ts`), "utf8");

    for (const route of source.matchAll(
      /app\.(?:get|post|put|patch|delete)\(\s*"([^"]*)"/g,
    )) {
      const path = `${match[2] ?? ""}${route[1]}`.replace(/\/+$/, "") || "/";

      const pattern = new RegExp(
        "^" +
          path
            .split("/")
            .map((segment) =>
              segment.startsWith(":")
                ? "[^/]+"
                : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("/") +
          "/?$",
      );

      routes.push({ path, pattern });
    }
  }

  return routes;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];

    const path = join(dir, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);

    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** `${x}` is one path segment; the query string is not part of the route. */
function shapeOf(template: string): string {
  return template
    .replace(/\$\{[^}]*\}/g, "SEG")
    .replace(/SEG(?=SEG)/g, "")
    .split("?")[0]
    .replace(/\/+$/, "");
}

function unmatched(
  files: string[],
  urlPattern: RegExp,
  routes: Route[],
): string[] {
  const misses = new Set<string>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(urlPattern)) {
      const shape = shapeOf(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
      const lineStart = source.lastIndexOf("\n", match.index) + 1;

      // A comment that shows the pattern is not a call.
      if (/^\s*(\*|\/\/)/.test(source.slice(lineStart, match.index))) continue;
      if (!shape.startsWith("/")) continue;
      if (routes.some((route) => route.pattern.test(shape))) continue;

      const line = source.slice(0, match.index).split("\n").length;
      misses.add(`${shape}  (${file.slice(resolve(API_ROOT, "..").length + 1)}:${line})`);
    }
  }

  return [...misses].sort();
}

const routes = apiRoutes();

const WEB = resolve(API_ROOT, "..", "trajetto-ui", "src");
const APP = resolve(API_ROOT, "..", "trajetto-mobile");

describe("the API's route table", () => {
  it("was read at all", () => {
    // A parser that silently found nothing would make every check below pass.
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.map((route) => route.path)).toContain(
      "/fines/delete-fine/:fineId/business/:businessId",
    );
  });
});

/**
 * Server code builds API URLs from HTTP_REQUEST; browser code from the runtime
 * public config, `${await publicApiUrl()}/path`, or — since the page holds no
 * token — through the same-origin relay, `relayUrl("/path")` (the same
 * patterns as trajetto-ui/scripts/check-api-routes.mjs). Reading only the
 * first missed every call the browser makes.
 */
const WEB_CALL =
  /`\$\{(?:process\.env\.(?:NEXT_PUBLIC_)?HTTP_REQUEST|await publicApiUrl\(\))\}(\/[^`\s]*)`|relayUrl\(\s*(?:`(\/[^`\s]*)`|\x22(\/[^\x22\s]*)\x22|\x27(\/[^\x27\s]*)\x27)/g;

/** The path a WEB_CALL match captured, whichever alternative matched. */
const calledPath = (match: RegExpMatchArray): string =>
  match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";

describe.skipIf(!existsSync(WEB))("what the web calls", () => {
  it("always has a route to land on", () => {
    const misses = unmatched(sourceFiles(WEB), WEB_CALL, routes);

    expect(misses).toEqual([]);
  });

  it("sees the calls the browser makes through the runtime config", () => {
    const browserCalls = sourceFiles(WEB).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(WEB_CALL)]
        .filter(([call]) => call.includes("publicApiUrl") || call.startsWith("relayUrl"))
        .map(calledPath),
    );

    expect(browserCalls).toContain("/user/me");
    expect(browserCalls.some((call) => call.startsWith("/kanban/list/"))).toBe(true);
  });
});

describe.skipIf(!existsSync(APP))("what the app calls", () => {
  it("always has a route to land on", () => {
    const files = ["app", "features", "hooks", "providers", "store", "utils"]
      .flatMap((dir) => sourceFiles(join(APP, dir)));

    const misses = unmatched(
      files,
      /apiClient\.(?:get|post|put|patch|delete|postFormData)(?:<[^>(]*>)?\(\s*[`"](\/[^`"\s]*)[`"]/g,
      routes,
    );

    expect(misses).toEqual([]);
  });
});
