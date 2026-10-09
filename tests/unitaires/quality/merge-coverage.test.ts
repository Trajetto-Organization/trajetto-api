import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The E2E coverage is measured in batches and joined by merge-coverage.mjs.
 * Istanbul's union is exact only when every batch saw the same source: a file
 * edited between batches keeps both statement maps, and the total grows a
 * phantom denominator. The 05/10 baseline was skewed exactly like that by
 * concurrent edits, so the merge must refuse such inputs. Function and
 * branch maps are checked where runs overlap (v8 lists only what each run's
 * profile saw, so they legitimately differ on the same source).
 */
const SCRIPT = resolve(__dirname, "..", "..", "..", "infra", "scripts", "merge-coverage.mjs");

const loc = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 10 } });

type Fn = { name: string; line: number };
type Branch = { line: number; arms: number[] };

const fileCoverage = (path: string, lines: number[], hits: number[], fns: Fn[] = [], branches: Branch[] = []) => ({
  path,
  statementMap: Object.fromEntries(lines.map((line, i) => [String(i), loc(line)])),
  s: Object.fromEntries(hits.map((hit, i) => [String(i), hit])),
  fnMap: Object.fromEntries(
    fns.map((fn, i) => [String(i), { name: fn.name, decl: loc(fn.line), loc: loc(fn.line), line: fn.line }]),
  ),
  f: Object.fromEntries(fns.map((_, i) => [String(i), 1])),
  branchMap: Object.fromEntries(
    branches.map((branch, i) => [
      String(i),
      { type: "branch", line: branch.line, loc: loc(branch.line), locations: branch.arms.map(loc) },
    ]),
  ),
  b: Object.fromEntries(branches.map((branch, i) => [String(i), branch.arms.map(() => 1)])),
});

let dir: string;

const write = (name: string, data: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
};

const merge = (...inputs: string[]) =>
  spawnSync(process.execPath, [SCRIPT, join(dir, "out"), ...inputs], { encoding: "utf8" });

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("merge-coverage.mjs", () => {
  it("joins hits of runs that saw the same source", () => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    const file = "/repo/src/a.ts";
    const a = write("a.json", { [file]: fileCoverage(file, [1, 2, 3], [1, 0, 0]) });
    const b = write("b.json", { [file]: fileCoverage(file, [1, 2, 3], [0, 0, 4]) });

    const result = merge(a, b);

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(dir, "out", "coverage-summary.json"), "utf8"));
    expect(summary.total.statements).toMatchObject({ total: 3, covered: 2 });
  });

  it("refuses runs whose source changed in between instead of inflating the total", () => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    const file = "/repo/src/a.ts";
    const before = write("before.json", { [file]: fileCoverage(file, [1, 2, 3], [1, 1, 1]) });
    // Same file after an edit: one line gone, the rest shifted.
    const after = write("after.json", { [file]: fileCoverage(file, [1, 4], [0, 1]) });

    const result = merge(before, after);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source changed between runs");
    expect(result.stderr).toContain(file);
  });

  it("accepts function and branch maps that differ only in what each run reported (v8)", () => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    const file = "/repo/src/a.ts";
    // Same source: v8 lists only the functions/branches its profile saw.
    const a = write("a.json", {
      [file]: fileCoverage(file, [1, 2, 3], [1, 1, 0], [{ name: "first", line: 1 }], [{ line: 2, arms: [2] }]),
    });
    const b = write("b.json", {
      [file]: fileCoverage(file, [1, 2, 3], [0, 0, 1], [{ name: "first", line: 1 }, { name: "second", line: 3 }]),
    });

    const result = merge(a, b);

    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses a branch-only drift: an arm added in place, statements unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    const file = "/repo/src/a.ts";
    const before = write("before.json", {
      [file]: fileCoverage(file, [1, 2, 3], [1, 1, 1], [], [{ line: 2, arms: [2] }]),
    });
    // A new ternary on line 2: same statements, one more arm at the same place.
    const after = write("after.json", {
      [file]: fileCoverage(file, [1, 2, 3], [1, 1, 1], [], [{ line: 2, arms: [2, 2] }]),
    });

    const result = merge(before, after);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });

  it("refuses a function renamed in place, statements unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    const file = "/repo/src/a.ts";
    const before = write("before.json", {
      [file]: fileCoverage(file, [1, 2], [1, 1], [{ name: "loadTenant", line: 1 }]),
    });
    const after = write("after.json", {
      [file]: fileCoverage(file, [1, 2], [1, 1], [{ name: "resolveTenant", line: 1 }]),
    });

    const result = merge(before, after);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});
