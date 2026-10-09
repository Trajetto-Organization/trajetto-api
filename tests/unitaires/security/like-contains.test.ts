import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { literalContains } from "@/shared/utils/like-pattern";

/**
 * A substring search has to search for the substring.
 *
 * Prisma compiles `{ contains: term }` to `LIKE '%' || term || '%'` (ILIKE
 * with `mode: "insensitive"`) and does not escape the term: "50%" was "50
 * followed by anything", "%" or "_" alone matched every row. The fix lives in
 * one place — buildSearchOr escapes every `contains` it assembles, and the
 * few single-field searches call escapeLikePattern themselves — and the guard
 * at the bottom keeps a new search from being written around it.
 */
describe("literalContains", () => {
  it("escapes every contains, however deep the relation filter", () => {
    expect(
      literalContains({
        OR: [
          { name: { contains: "50%", mode: "insensitive" } },
          { driver: { name: { contains: "a_b\\c", mode: "insensitive" } } },
          { cards: { some: { OR: [{ title: { contains: "%" } }] } } },
        ],
      }),
    ).toEqual({
      OR: [
        { name: { contains: "50\\%", mode: "insensitive" } },
        { driver: { name: { contains: "a\\_b\\\\c", mode: "insensitive" } } },
        { cards: { some: { OR: [{ title: { contains: "\\%" } }] } } },
      ],
    });
  });

  it("leaves every other filter value as it was", () => {
    const when = new Date("2026-09-24T00:00:00.000Z");
    const condition = {
      status: { in: ["IN_PROGRESS", "DONE"] },
      code: 50,
      amount: 12.5,
      name: { equals: "a_b" },
      created_at: { gte: when },
      deleted_at: null,
    };

    const escaped = literalContains(condition);

    expect(escaped).toEqual(condition);
    expect(escaped.created_at.gte).toBe(when);
  });

  it("does not touch the caller's object", () => {
    const condition = { name: { contains: "50%" } };

    literalContains(condition);

    expect(condition).toEqual({ name: { contains: "50%" } });
  });
});

describe("buildSearchOr", () => {
  it("hands Prisma the search term as literal text", () => {
    expect(
      buildSearchOr([
        { name: { contains: "50%", mode: "insensitive" } },
        {},
        { email: { contains: "_", mode: "insensitive" } },
      ]),
    ).toEqual({
      OR: [
        { name: { contains: "50\\%", mode: "insensitive" } },
        { email: { contains: "\\_", mode: "insensitive" } },
      ],
    });
  });
});

/**
 * Every `contains` in src reaches Prisma escaped.
 *
 * A `contains` passes when its value is an `escapeLikePattern(...)` call, or
 * when the object holding it ends up in buildSearchOr: written inside the call,
 * or pushed into / assigned to a variable that — directly or through other
 * variables of the same function — is handed to it. Anything else is a search
 * that treats `%` and `_` as wildcards.
 */
const SRC = resolve(process.cwd(), "src");
const LIKE_KEYS = new Set(["contains", "startsWith", "endsWith"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      // The in-memory fakes filter arrays with String#includes, not SQL.
      return entry.name === "in-memory" ? [] : sourceFiles(path);
    }

    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function identifiersIn(node: ts.Node): string[] {
  const names: string[] = [];

  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child)) names.push(child.text);
    ts.forEachChild(child, visit);
  };

  visit(node);

  return names;
}

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }

  return node.getSourceFile();
}

/** Variables of `scope` whose contents end up inside a buildSearchOr call. */
function variablesReachingSearchOr(scope: ts.Node): Set<string> {
  const reaching = new Set<string>();
  const flows: Array<{ into: string; from: ts.Node }> = [];

  const visit = (node: ts.Node) => {
    if (isCallTo(node, "buildSearchOr")) {
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) reaching.add(argument.text);
      }
    }

    // X.push(...args)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      for (const argument of node.arguments) {
        flows.push({ into: node.expression.expression.text, from: argument });
      }
    }

    // const X = ...
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      flows.push({ into: node.name.text, from: node.initializer });
    }

    ts.forEachChild(node, visit);
  };

  visit(scope);

  let grew = true;

  while (grew) {
    grew = false;

    for (const flow of flows) {
      if (!reaching.has(flow.into)) continue;

      for (const name of identifiersIn(flow.from)) {
        if (!reaching.has(name)) {
          reaching.add(name);
          grew = true;
        }
      }
    }
  }

  return reaching;
}

function isEscaped(property: ts.ObjectLiteralElementLike): boolean {
  if (
    ts.isPropertyAssignment(property) &&
    isCallTo(property.initializer, "escapeLikePattern")
  ) {
    return true;
  }

  const reaching = variablesReachingSearchOr(enclosingFunction(property));
  let current: ts.Node | undefined = property.parent;

  while (current) {
    if (isCallTo(current, "buildSearchOr")) return true;

    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "push" &&
      ts.isIdentifier(current.expression.expression) &&
      reaching.has(current.expression.expression.text)
    ) {
      return true;
    }

    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      reaching.has(current.name.text)
    ) {
      return true;
    }

    if (ts.isFunctionLike(current)) return false;

    current = current.parent;
  }

  return false;
}

describe("every LIKE filter in src", () => {
  it("escapes the wildcards of what the user typed", () => {
    const unescaped: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (![...LIKE_KEYS].some((key) => text.includes(key))) continue;

      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

      const visit = (node: ts.Node) => {
        if (
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)) &&
          ts.isIdentifier(node.name) &&
          LIKE_KEYS.has(node.name.text) &&
          !isEscaped(node)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );

          unescaped.push(`${relative(SRC, file)}:${line + 1}`);
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(unescaped).toEqual([]);
  });
});
