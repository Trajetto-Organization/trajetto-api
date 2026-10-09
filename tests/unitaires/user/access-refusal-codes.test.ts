import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The user, permission and access-profile modules raise the permission
 * refusal through `permissionDenied` (decision 4.1), never by spelling the
 * code by hand. create-user and update-user built
 * `new AppError(msg, 403, "PERMISSION_DENIED")` themselves: one typo there
 * and the web reads the refusal as an unknown error instead of "sem
 * permissão". The shared sweep covers the guards; this one covers the
 * modules this area owns.
 */
const ROOT = join(__dirname, "..", "..", "..", "src");
const SWEPT = ["user", "permission", "profile-access"].map((name) =>
  join(ROOT, "modules", name),
);

const CODE = /["'`](PERMISSION_DENIED|MODULE_NOT_ENABLED|TENANT_INACTIVE)["'`]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the admin-users modules' access refusals", () => {
  it("never spell an access code by hand", () => {
    const files = SWEPT.flatMap(sourceFiles);

    // A floor, so an emptied glob cannot pass by finding nothing.
    expect(files.length).toBeGreaterThan(60);

    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => CODE.test(line))
        .map(({ index }) => `${relative(ROOT, file).split(sep).join("/")}:${index + 1}`),
    );

    expect(offenders).toEqual([]);
  });
});
