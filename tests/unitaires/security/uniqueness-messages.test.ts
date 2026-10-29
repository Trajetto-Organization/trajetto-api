import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What a "not available" error may say.
 *
 * Eleven of them said the value "must be unique in the whole system". That
 * sentence told a tenant that another tenant had registered it — a plate, a
 * CPF, a CNH — which is exactly what it must not learn, and it promised a
 * global rule that is a product decision still open (and no longer true for
 * a branch's ERP code or a driver's RG). The OpenAPI examples repeated it.
 */
const SOURCE = resolve(__dirname, "../../../src");

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("uniqueness errors", () => {
  it("never claim a value is unique across the whole system", () => {
    const offenders = filesUnder(SOURCE)
      .filter((path) => path.endsWith(".ts"))
      .filter((path) => readFileSync(path, "utf8").includes("todo o sistema"))
      .map((path) => path.slice(SOURCE.length + 1));

    expect(offenders).toEqual([]);
  });
});
