import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The three 403s a client must tell apart (decision 4.1) are raised only
 * through the factories in src/shared/errors/access-errors.ts.
 *
 * ensure-api-key.ts still spelled TENANT_INACTIVE and MODULE_NOT_ENABLED by
 * hand after the factories existed: one typo there and an integrator's
 * client reads an unknown code as a generic failure. Swept over the guards
 * and the shared layer, where these refusals are decided.
 */
const ROOT = join(__dirname, "..", "..", "..", "src");
// The user, permission and profile modules decide role and scope refusals
// too; they use permissionDenied() since admin-users (access-refusal-codes).
const SWEPT = [
  join(ROOT, "modules", "middlewares"),
  join(ROOT, "shared"),
  join(ROOT, "modules", "user"),
  join(ROOT, "modules", "permission"),
  join(ROOT, "modules", "profile-access"),
];
const FACTORIES = join(ROOT, "shared", "errors", "access-errors.ts");

const CODE = /["'`](PERMISSION_DENIED|MODULE_NOT_ENABLED|TENANT_INACTIVE)["'`]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the access refusal codes", () => {
  it("are spelled only by their factories", () => {
    const files = SWEPT.flatMap(sourceFiles);

    // A floor, so an emptied glob cannot pass by finding nothing.
    expect(files.length).toBeGreaterThan(20);

    const offenders = files
      .filter((file) => file !== FACTORIES)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => CODE.test(line))
          .map(
            ({ index }) =>
              `${relative(ROOT, file).split(sep).join("/")}:${index + 1}`,
          ),
      );

    expect(offenders).toEqual([]);
  });
});
