import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The mutation floor the owner delegated (decision 15, 07/10/2026): break 90.
 * Read as text: the config is an untyped .mjs the typecheck cannot import.
 */
describe("the mutation run's floor", () => {
  it("fails below a 90% mutation score", () => {
    const config = readFileSync(resolve(process.cwd(), "stryker.config.mjs"), "utf8");

    expect(config).toMatch(/thresholds:\s*\{\s*high:\s*90,\s*low:\s*75,\s*break:\s*90\s*\}/);
  });
});
