import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import {
  coverageConfigDefaults,
  defaultExclude,
  defaultInclude,
} from "vitest/config";
import { describe, expect, it } from "vitest";

import config from "../../../vite.config.mjs";

/**
 * Coverage measured honestly (decision 13.1, TEST-COV-1).
 *
 * The old config replaced Vitest's default excludes (an `exclude` array
 * replaces them, it does not extend them), so the test files themselves were
 * counted as covered code; and it carved out src/config (rate limit, CORS,
 * trusted edge), src/http.ts and the Resend provider — logic, excluded only
 * because it was untested. This pins the honest shape.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type Coverage = {
  provider?: string;
  all?: boolean;
  include?: string[];
  exclude?: string[];
  reportOnFailure?: boolean;
};

const coverage = (config.test?.coverage ?? {}) as Coverage;

// Every .ts under src except declaration files (type-only, no code).
const productFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return productFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });

// The filter the v8 provider itself applies (@vitest/coverage-v8 1.6,
// provider.js): test-exclude over Vitest's defaults plus the coverage exclude.
const coverageFilter = () => {
  const providerRequire = createRequire(
    createRequire(join(ROOT, "package.json")).resolve("@vitest/coverage-v8"),
  );
  const TestExclude = providerRequire("test-exclude");
  return new TestExclude({
    cwd: ROOT,
    include: coverage.include,
    exclude: [
      ...defaultExclude,
      ...defaultInclude,
      ...(coverage.exclude ?? coverageConfigDefaults.exclude),
    ],
    excludeNodeModules: true,
    relativePath: true,
  }) as { shouldInstrument: (file: string) => boolean };
};

describe("API coverage configuration", () => {
  it("measures every TypeScript file under src, untested ones included", () => {
    expect(coverage.provider).toBe("v8");
    expect(coverage.all).toBe(true);
    expect(coverage.include).toEqual(["src/**/*.ts"]);
  });

  it("keeps Vitest's default excludes (tests, *.d.ts), only narrowing the test-name glob", () => {
    const expected = coverageConfigDefaults.exclude.map((glob) =>
      glob === "**/*{.,-}{test,spec}?(-d).?(c|m)[jt]s?(x)"
        ? "**/*.{test,spec}?(-d).?(c|m)[jt]s?(x)"
        : glob,
    );
    expect([...(coverage.exclude ?? [])].sort()).toEqual([...expected].sort());
  });

  it("drops no product file under src, whatever its name", () => {
    const filter = coverageFilter();
    const files = productFiles("src");

    expect(files.length).toBeGreaterThan(100);
    expect(
      files.filter((file) => !filter.shouldInstrument(join(ROOT, file))),
    ).toEqual([]);
    // A product file named like a test (Vitest's default `*-spec.ts`) counts.
    expect(
      filter.shouldInstrument(join(ROOT, "src/shared/http/public-spec.ts")),
    ).toBe(true);
    expect(
      filter.shouldInstrument(join(ROOT, "src/shared/http/public.spec.ts")),
    ).toBe(false);
  });

  it("does not carve product code out of the measurement", () => {
    for (const pattern of coverage.exclude ?? []) {
      expect(pattern.startsWith("src/"), pattern).toBe(false);
      expect(pattern, pattern).not.toMatch(
        /http\.ts|resend|config\/|server\.ts|env/,
      );
    }
  });

  it("still reports when a test fails, so a red run is not also a blind one", () => {
    expect(coverage.reportOnFailure).toBe(true);
  });

  it("measures the unit suite only in one process (the E2E suite runs in batches)", () => {
    const { scripts } = JSON.parse(read("package.json"));

    // The floor flags that follow are pinned in lifecycle/compose-package-scripts.
    expect(scripts["test:coverage"]).toMatch(
      /^vitest run --dir tests\/unitaires --coverage( |$)/,
    );
    expect(scripts["test:coverage:e2e"]).toBe(
      "bash infra/scripts/coverage-e2e.sh",
    );
  });

  it("is published and gated by the branch CI", () => {
    const ci = read(".github/workflows/ci.yml");

    // test:coverage, not `yarn test --coverage`: only the script carries the floor.
    expect(ci).toMatch(/run: yarn test:coverage --reporter=basic\b/);
    expect(ci).not.toMatch(
      /run: yarn test --run --reporter=basic --coverage\b/,
    );
    expect(ci).toMatch(
      /name: coverage-\$\{\{ github\.sha \}\}\n\s+path: coverage\n/,
    );
  });

  it("is gated again by the staging pipeline, before any image is built", () => {
    const deploy = read(".github/workflows/deploy.yml");

    expect(deploy).toMatch(/run: yarn test:coverage --reporter=basic\b/);
    expect(deploy).toMatch(/needs: \[test, ai-ocr, secrets\]/);
  });
});
