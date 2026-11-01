import { existsSync, readFileSync } from "node:fs";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The source key of the release image (.github/scripts/migrate-source.sh).
 *
 * build-and-push reuses the release image tagged `src-<key>` instead of
 * building it again, and the deploys run the release step only when that
 * image is not the one their database applied. So the key must change
 * whenever anything the release step runs or reads changes — a migration,
 * a seed, a file a seed imports — or a new migration would never reach the
 * database (the API's schema guard would then refuse to boot: loud, but a
 * broken deploy). And it must NOT change for the rest of the API, or every
 * push would run the step again.
 *
 * The list in the script is checked against what the image really runs:
 * the entry points the entrypoint's release mode calls, bundled as tsup
 * bundles them, and the files the release stage of the Dockerfile copies.
 */
const read = (path: string) =>
  readFileSync(repoFile(path), "utf8").replace(/\r\n/g, "\n");

const bash = hasShell("bash");

/** The paths the key hashes, from the script itself. */
function listed(): string[] {
  const text = read(".github/scripts/migrate-source.sh");
  const block = /\nPATHS=\(\n([\s\S]*?)\n\)/.exec(text)?.[1] ?? "";

  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const covered = (path: string, paths: string[]) =>
  paths.some((each) => path === each || path.startsWith(`${each}/`));

/**
 * The compiled scripts the entrypoint runs in the release step
 * (`node build/<name>.js`), mapped back to their sources through tsup's
 * entries.
 */
function releaseEntryPoints(): string[] {
  const entrypoint = read("infra/scripts/docker-entrypoint.sh");
  const start = entrypoint.indexOf(
    'if [ "$MODE" = "migrate" ] || [ "$MODE" = "release" ]; then',
  );
  const end = entrypoint.indexOf("exec tail -f /dev/null", start);

  expect(start, "o bloco da etapa de release no entrypoint").toBeGreaterThan(
    -1,
  );
  expect(end).toBeGreaterThan(start);

  const names = [
    ...entrypoint.slice(start, end).matchAll(/node build\/([\w-]+)\.js/g),
  ].map((match) => match[1]);
  const tsup = read("tsup.config.ts");
  const entries = Object.fromEntries(
    [...tsup.matchAll(/^\s+"?([\w-]+)"?: "\.\/([^"]+)"/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );

  return [...new Set(names)].map((name) => {
    expect(entries[name], `entrada ${name} no tsup.config.ts`).toBeDefined();

    return entries[name];
  });
}

describe("the release image's source key", () => {
  it("lists only paths that exist", () => {
    for (const path of listed()) {
      expect(existsSync(repoFile(path)), path).toBe(true);
    }
  });

  it("finds the release step's entry points where the entrypoint runs them", () => {
    expect(releaseEntryPoints().sort()).toEqual([
      "infra/scripts/import-violation-codes.ts",
      "infra/scripts/seed.ts",
      "infra/scripts/wait-for-postgres.ts",
    ]);
  });

  // tsup bundles every file of ours a script imports into build/<name>.js:
  // a change to any of them changes what the release step runs. Ours: a
  // relative import, or one through an alias of tsconfig.json's `paths`
  // (`@/*`, `infra/*`), which tsup bundles too; anything else is a package.
  it("covers every file of ours the release step's scripts import", async () => {
    const aliases = Object.keys(
      (
        JSON.parse(read("tsconfig.json")) as {
          compilerOptions: { paths: Record<string, string[]> };
        }
      ).compilerOptions.paths,
    ).map((alias) => alias.replace(/\*$/, ""));

    expect(aliases).toEqual(expect.arrayContaining(["@/", "infra/"]));

    const result = await build({
      entryPoints: releaseEntryPoints(),
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "cjs",
      outdir: "release-bundle",
      tsconfig: repoFile("tsconfig.json"),
      absWorkingDir: repoFile("."),
      logLevel: "silent",
      plugins: [
        {
          // Packages stay outside, as tsup's skipNodeModulesBundle leaves
          // them; relative imports and the tsconfig aliases are bundled.
          name: "packages-outside",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.path.startsWith(".") ||
              aliases.some((alias) => args.path.startsWith(alias))
                ? undefined
                : { path: args.path, external: true },
            );
          },
        },
      ],
    });
    const inputs = Object.keys(result.metafile.inputs);
    const paths = listed();

    expect(inputs.length).toBeGreaterThan(3);

    for (const input of inputs) {
      expect(
        covered(input, paths),
        `${input} entra na imagem de migração e não está em migrate-source.sh`,
      ).toBe(true);
    }

    // The API's environment schema is not one of them: the release
    // Application has only the database URL (seed.ts).
    expect(inputs).not.toContain("src/env/index.ts");
  });

  it("covers every file the release stage copies from the build", () => {
    const dockerfile = read("Dockerfile");
    const stage = dockerfile.slice(
      dockerfile.indexOf("FROM runner AS migrate"),
    );
    const sources = [
      ...stage.matchAll(/^COPY --from=builder \S+ \/app\/(\S+) /gm),
    ].map((match) => match[1].replace(/\/$/, ""));

    expect(sources.length).toBeGreaterThan(3);

    for (const source of sources) {
      // release/ holds the compiled seeds: the bundle check above.
      if (source === "release") continue;
      expect(covered(source, listed()), source).toBe(true);
    }
  });

  it("covers what builds the image and the entrypoint that chains the step", () => {
    const paths = listed();

    for (const path of [
      "Dockerfile",
      ".dockerignore",
      "package.json",
      "yarn.lock",
      "tsconfig.json",
      "tsup.config.ts",
      "prisma.config.ts",
      "prisma/schema.prisma",
      "prisma/migrations",
      "infra/scripts/docker-entrypoint.sh",
    ]) {
      expect(paths, path).toContain(path);
    }
  });
});

/**
 * The key, computed for real in a throwaway repository holding every listed
 * path.
 */
describe.skipIf(!bash)("the key, computed", () => {
  let box: Sandbox;
  let git: (...args: string[]) => ReturnType<typeof run>;

  beforeEach(() => {
    box = sandbox();
    box.file(
      "tests-git.sh",
      'exec git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"\n',
    );
    git = (...args) =>
      run("bash", `${box.root}/tests-git.sh`, args, { cwd: box.root });

    git("init", "-q");

    for (const path of listed()) {
      // Directories hold a file; files are files.
      if (path === "prisma/migrations" || path === "src/shared/database") {
        box.file(`${path}/one`, path);
      } else {
        box.file(path, path);
      }
    }

    box.file("src/modules/route/route.ts", "export {}");
    commit("first");
  });

  afterEach(() => box.dispose());

  function commit(message: string) {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  }

  const key = () =>
    run("bash", repoFile(".github/scripts/migrate-source.sh"), [], {
      cwd: box.root,
    });

  it("is a 40-hex hash, the same for the same commit", () => {
    const first = key();

    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(key().stdout).toBe(first.stdout);
  });

  it("stays the same when only the rest of the API changes", () => {
    const before = key().stdout;

    box.file("src/modules/route/route.ts", "export const changed = true;");
    box.file("docs/deploy.md", "# docs");
    commit("api only");

    expect(key().stdout).toBe(before);
  });

  it.each([
    ["a new migration", "prisma/migrations/20261101000000_new/migration.sql"],
    ["a seed", "infra/scripts/seed.ts"],
    ["a file a seed imports", "src/shared/database/pool-config.ts"],
    ["the infraction table", "tabela-codigo-infracoes-renainf-xlsx.xlsx"],
    ["the dependencies", "yarn.lock"],
    ["the entrypoint", "infra/scripts/docker-entrypoint.sh"],
  ])("changes with %s", (_case, path) => {
    const before = key().stdout;

    box.file(path, `changed ${path}`);
    commit(path);

    expect(key().stdout).not.toBe(before);
  });

  it("fails, naming the path, when a listed file is gone", () => {
    git("rm", "-q", "infra/scripts/seed.ts");
    commit("renamed the seed");

    const result = key();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "infra/scripts/seed.ts não existe no commit",
    );
    expect(result.stdout).toBe("");
  });

  it("lists its paths, and refuses anything else", () => {
    const list = run(
      "bash",
      repoFile(".github/scripts/migrate-source.sh"),
      ["--list"],
      { cwd: box.root },
    );

    expect(list.stdout.trim().split("\n")).toEqual(listed());
    expect(
      run("bash", repoFile(".github/scripts/migrate-source.sh"), ["x"], {
        cwd: box.root,
      }).status,
    ).toBe(2);
  });
});
