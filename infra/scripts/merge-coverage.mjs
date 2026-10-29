// Joins the coverage-final.json of several Vitest runs into one report.
//
// Why: the integration suite is measured in batches (see coverage-e2e.sh;
// the size comes from Prisma 6, whose native engine crashed on Windows when
// one process loaded ~12+ E2E files). Vitest 1.6 has no --merge-reports,
// and each batch alone under-reports every file the other batches exercise.
// Istanbul merges hit counts per statement/branch/function, so the union is
// exact, not averaged.
//
// That union is only exact when every run saw the same source. If a file
// changed between runs, Istanbul keeps both statement maps side by side and
// the total silently grows a phantom denominator (and phantom hits). The merge
// therefore refuses inputs whose maps for one file disagree: re-measure from
// one tree instead of publishing a number nobody can reproduce.
//
// What "disagree" can mean is limited by the v8 provider: its statement map is
// a pure function of the source, but its function and branch maps list only
// what that run's V8 profile reported, so they legitimately differ between
// runs of the same file. Those are compared where they overlap: one location
// must carry the same function name and the same branch arms in every run (a
// rename, or an arm added or removed in place, is drift). A function or branch
// that appears at a new location while every statement stays put cannot be
// told apart from "this run executed more"; coverage-e2e.sh covers that window
// by refusing to merge when the src tree's digest changed during the batches.
//
// Usage: node infra/scripts/merge-coverage.mjs <out-dir> <coverage-final.json...>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const libCoverage = require("istanbul-lib-coverage");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");

const [outDir, ...inputs] = process.argv.slice(2);

if (!outDir || inputs.length === 0) {
  console.error("usage: merge-coverage.mjs <out-dir> <coverage-final.json...>");
  process.exit(2);
}

// The statement map is the source's fingerprint: same file, same lines.
const fingerprint = (fileCoverage) => JSON.stringify(fileCoverage.statementMap);

const at = ({ start, end }) =>
  `${start.line}:${start.column}-${end.line}:${end.column}`;

// v8's placeholder for a file no test loaded (`all: true`); not a function.
const EMPTY_REPORT = "(empty-report)";

// location -> what must stay the same there across runs of one source.
const shapes = (fileCoverage) => {
  const shape = new Map();
  for (const fn of Object.values(fileCoverage.fnMap ?? {})) {
    if (fn.name !== EMPTY_REPORT) shape.set(`fn ${at(fn.loc)}`, fn.name);
  }
  for (const branch of Object.values(fileCoverage.branchMap ?? {})) {
    shape.set(
      `branch ${at(branch.loc)}`,
      JSON.stringify([branch.type, branch.locations.map(at)]),
    );
  }
  return shape;
};

const seen = new Map();
const drifted = new Map();
const map = libCoverage.createCoverageMap({});

for (const input of inputs) {
  const data = JSON.parse(readFileSync(input, "utf8"));

  for (const [file, fileCoverage] of Object.entries(data)) {
    const print = fingerprint(fileCoverage);
    const first = seen.get(file);

    if (!first) {
      seen.set(file, { print, input, shape: shapes(fileCoverage) });
      continue;
    }
    if (first.print !== print) {
      drifted.set(file, [first.input, input]);
      continue;
    }
    for (const [where, what] of shapes(fileCoverage)) {
      const known = first.shape.get(where);
      if (known === undefined) first.shape.set(where, what);
      else if (known !== what) drifted.set(file, [first.input, input]);
    }
  }

  map.merge(data);
}

if (drifted.size > 0) {
  console.error(
    `source changed between runs for ${drifted.size} file(s); refusing to merge:`,
  );
  for (const [file, [a, b]] of [...drifted].slice(0, 20)) {
    console.error(`  ${file}\n    ${a}\n    ${b}`);
  }
  process.exit(1);
}

const context = libReport.createContext({ dir: outDir, coverageMap: map });

for (const name of ["json", "json-summary", "lcov", "text-summary"]) {
  reports.create(name).execute(context);
}

console.log(`merged ${inputs.length} report(s) into ${outDir}`);
