import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * synchronous_commit stays on (plano-escala F5-20; decisions P6 and D9).
 *
 * The app drops a GPS point from its buffer when the POST answers 2xx
 * (trajetto-mobile/features/tracking/reporter.ts), and every write of the
 * API is acknowledged after its COMMIT. `synchronous_commit=off` — global,
 * per role, per session, or a `SET LOCAL` in one transaction — answers the
 * COMMIT before its WAL reaches the disk: a crash of Postgres then loses
 * writes the phone was already told were saved, with no error anywhere.
 * The owner decided against it; if the WAL ever becomes the bottleneck, the
 * safe lever is commit_delay/commit_siblings, by environment in the
 * trajetto-postgres image (F1-01).
 *
 * Blunt on purpose: the name may not appear at all in what the API runs or
 * migrates — code, raw SQL, migrations, a connection option in the example
 * environment — not even in a comment. Changing it is a decision to take
 * with the owner, not a line to slip into a diff.
 */
const ROOT = process.cwd();

/** What the API runs, migrates or is configured from. */
const SCANNED = ["src", "prisma", "infra/sql", ".env.example"];

/** Any spelling Postgres or a URL would take: _ - or %5F, any case. */
const SYNCHRONOUS_COMMIT = /synchronous(?:_|-|%5f)commit/i;

interface Finding {
  file: string;
  line: number;
  text: string;
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const child = join(path, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : walk(child);
    }

    return [child];
  });
}

/** Every line, under the given roots, that names synchronous_commit. */
function findSynchronousCommit(root: string, scanned: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const target of scanned) {
    const path = resolve(root, target);
    if (!existsSync(path)) continue;
    const files = readdirSafe(path) ? walk(path) : [path];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);

      lines.forEach((text, at) => {
        if (SYNCHRONOUS_COMMIT.test(text)) {
          findings.push({
            file: relative(root, file).replace(/\\/g, "/"),
            line: at + 1,
            text: text.trim(),
          });
        }
      });
    }
  }

  return findings;
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

let planted: string | null = null;

afterEach(() => {
  if (planted) rmSync(planted, { recursive: true, force: true });
  planted = null;
});

/** A throwaway tree with the given files, scanned like the repository. */
function plant(files: Record<string, string>): string {
  planted = mkdtempSync(join(tmpdir(), "trajetto-sync-commit-"));

  for (const [name, content] of Object.entries(files)) {
    const path = join(planted, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  return planted;
}

describe("synchronous_commit", () => {
  it("appears nowhere in the code, the migrations or the example environment", () => {
    expect(findSynchronousCommit(ROOT, SCANNED)).toEqual([]);
  });

  it("is looked for in every migration and every source file", () => {
    // A walk that read nothing would pass the test above forever.
    const migrations = walk(resolve(ROOT, "prisma/migrations")).filter((file) =>
      file.endsWith("migration.sql"),
    );
    const sources = walk(resolve(ROOT, "src")).filter((file) =>
      file.endsWith(".ts"),
    );

    expect(migrations.length).toBeGreaterThan(50);
    expect(sources.length).toBeGreaterThan(500);
  });

  it("catches a planted SET LOCAL in a repository", () => {
    const root = plant({
      "src/modules/route/repositories/prisma-route-repository.ts": [
        "export async function flush(tx: Tx) {",
        "  await tx.$executeRaw`SET LOCAL synchronous_commit = off`;",
        "}",
      ].join("\n"),
    });

    expect(findSynchronousCommit(root, SCANNED)).toEqual([
      {
        file: "src/modules/route/repositories/prisma-route-repository.ts",
        line: 2,
        text: "await tx.$executeRaw`SET LOCAL synchronous_commit = off`;",
      },
    ]);
  });

  it("catches every other way of switching it off", () => {
    const root = plant({
      "prisma/migrations/20990101000000_x/migration.sql":
        "ALTER ROLE trajetto SET Synchronous_Commit TO 'off';\n",
      "infra/sql/20-runtime-roles.sql":
        "ALTER DATABASE trajetto SET synchronous_commit = local;\n",
      "src/shared/database/pool.ts":
        "const sql = \"SELECT set_config('synchronous_commit', 'off', true)\";\n",
      ".env.example":
        "DATABASE_URL=postgresql://u@h/db?options=-c%20synchronous%5Fcommit%3Doff\n",
    });

    expect(
      findSynchronousCommit(root, SCANNED).map((finding) => finding.file),
    ).toEqual([
      "src/shared/database/pool.ts",
      "prisma/migrations/20990101000000_x/migration.sql",
      "infra/sql/20-runtime-roles.sql",
      ".env.example",
    ]);
  });

  it("leaves commit_delay alone: it is the safe lever", () => {
    const root = plant({
      "src/shared/database/settings.ts":
        "const lever = 'commit_delay and commit_siblings';\n",
    });

    expect(findSynchronousCommit(root, SCANNED)).toEqual([]);
  });
});
