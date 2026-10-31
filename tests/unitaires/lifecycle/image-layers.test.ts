import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasShell, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * How the images are cut into layers, for the server that pulls them.
 *
 * The staging VPS pulls GHCR blobs over an IPv6 route that resets
 * connections mid-download; Docker restarts a broken layer from zero and
 * keeps the finished ones. The AI image was one 145 MB pip layer — nothing
 * survived between Dokploy's retries (run 40551925038 failed 3/3) and a
 * Pillow bump re-shipped all of it — with the models in the same layer as
 * server.py. And a build arg declared early is in the cache key of every
 * RUN after it: the commit each image now carries must not rebuild a layer.
 *
 * Text-based, like the other Dockerfile checks: the build itself runs in CI
 * (`docker build --target test infra/ai-ocr`, build-and-push).
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** The instructions of a Dockerfile, continuation lines joined. */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** A stage's instructions, from its FROM to the next one. */
function stage(dockerfile: string, name: string): string[] {
  const all = instructions(dockerfile);
  const start = all.findIndex((line) =>
    new RegExp(`^FROM .+ AS ${name}$`, "i").test(line),
  );

  expect(start, `stage ${name}`).toBeGreaterThan(-1);

  const end = all.findIndex((line, at) => at > start && /^FROM /i.test(line));

  return all.slice(start, end < 0 ? undefined : end);
}

const ai = read("infra/ai-ocr/Dockerfile");
const api = read("Dockerfile");

/** Runtime requirements files (the test stage's is not shipped). */
const runtimeFiles = readdirSync(resolve(ROOT, "infra/ai-ocr"))
  .filter((name) => /^requirements(?:-[\w-]+)?\.txt$/.test(name))
  .filter((name) => name !== "requirements-test.txt");

const pins = (name: string) =>
  read(`infra/ai-ocr/${name}`)
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));

describe("the AI image's pip layers", () => {
  const LAYERS = [
    "requirements-opencv.txt",
    "requirements-onnxruntime.txt",
    "requirements-rapidocr.txt",
    "requirements-numpy.txt",
    "requirements.txt",
  ];

  const install = (file: string) =>
    `RUN --mount=type=bind,source=${file},target=/tmp/requirements.txt pip install --require-hashes --no-deps -r /tmp/requirements.txt`;

  it("install one requirements file per layer, in the order they change, hashes required", () => {
    const installs = stage(ai, "base").filter((line) =>
      /pip install/.test(line),
    );

    // Each RUN may go on (`&& …`) to prune that same layer, nothing else.
    expect(installs.map((line) => line.split(" && ")[0])).toEqual(
      LAYERS.map(install),
    );
    // Bind-mounted, never COPY'd up front: one COPY of every file would put
    // each layer behind the most edited file.
    expect(
      stage(ai, "base").some((line) => /^COPY .*requirements/.test(line)),
    ).toBe(false);
    expect([...runtimeFiles].sort()).toEqual([...LAYERS].sort());
  });

  // Wheels ship test suites, cascades and tooling the OCR never imports
  // (§14, measured on 28/10/2026: 1,444 files, ~31 MB). Deleted in the SAME
  // RUN as their install: a later RUN would only hide them, and every pull
  // would still carry them.
  it("prune what the service never imports, inside the RUN that installed it", () => {
    const base = stage(ai, "base");
    const run = (file: string) =>
      base.find((line) => line.startsWith(install(file))) ?? "";
    const site =
      'site="$(python -c \'import sysconfig; print(sysconfig.get_path("purelib"))\')"';

    expect(run("requirements-opencv.txt")).toBe(
      `${install("requirements-opencv.txt")} && ${site} && rm -f "$site"/cv2/data/*.xml`,
    );
    expect(run("requirements-onnxruntime.txt")).toBe(
      `${install("requirements-onnxruntime.txt")} && ${site} && rm -rf "$site/onnxruntime/tools" "$site/onnxruntime/transformers" "$site/onnxruntime/quantization"`,
    );
    // numpy.testing imports numpy/_core/tests/_natype.py: kept, and the
    // import is tried in the same RUN.
    expect(run("requirements-numpy.txt")).toBe(
      `${install("requirements-numpy.txt")} && ${site} && find "$site/numpy" -path '*/tests/*' ! -path '*/numpy/_core/tests/_natype.py' -delete && find "$site/numpy" -type d -name tests -empty -delete && python -c 'import numpy.testing'`,
    );
    expect(run("requirements-rapidocr.txt")).toBe(
      install("requirements-rapidocr.txt"),
    );
    expect(run("requirements.txt")).toBe(install("requirements.txt"));
    // No RUN of its own that deletes: it would reclaim nothing.
    expect(
      base.filter((line) => /^RUN /.test(line) && !/pip install/.test(line)),
    ).toEqual([]);
  });

  it("pin and hash every package, each in exactly one layer", () => {
    const seen = new Map<string, string>();

    for (const file of runtimeFiles) {
      const lines = pins(file);

      expect(lines.length, file).toBeGreaterThan(0);

      for (const line of lines) {
        const match = line.match(
          /^([A-Za-z0-9_.-]+)==[\w.]+ --hash=sha256:[0-9a-f]{64}$/,
        );

        expect(match, `${file}: ${line}`).not.toBeNull();

        const name = match![1].toLowerCase();

        expect(
          seen.get(name),
          `${name} em ${file} e ${seen.get(name)}`,
        ).toBeUndefined();
        seen.set(name, file);
      }
    }
  });

  it("keep the engine out of the last layer, and the bumped libraries in it", () => {
    const where = new Map(
      runtimeFiles.flatMap((file) =>
        pins(file).map(
          (line) => [line.split("==")[0].toLowerCase(), file] as const,
        ),
      ),
    );

    // Measured by the benchmark and ignored by Dependabot: they never ride
    // along with a security bump.
    expect(where.get("opencv-python-headless")).toBe("requirements-opencv.txt");
    expect(where.get("onnxruntime")).toBe("requirements-onnxruntime.txt");
    expect(where.get("rapidocr")).toBe("requirements-rapidocr.txt");
    expect(where.get("numpy")).toBe("requirements-numpy.txt");

    // What the image scan and Dependabot move: the last layer only.
    for (const name of [
      "pillow",
      "certifi",
      "urllib3",
      "requests",
      "protobuf",
      "flatbuffers",
    ]) {
      expect(where.get(name), name).toBe("requirements.txt");
    }
  });
});

describe("the AI image's models and code", () => {
  it("check the models in a stage of their own, offline, with fixed owner, mode and mtimes", () => {
    const models = stage(ai, "models").join("\n");

    expect(stage(ai, "models")[0]).toMatch(/^FROM base AS models$/);
    // The PP-OCRv5 pair came from www.modelscope.cn on every build without
    // cache (one request, no retry). Now it is versioned in models/, and the
    // RUN has no network: RapidOCR trying to download fails the build.
    expect(models).toMatch(
      /^RUN --network=none --mount=type=bind,source=models,target=\/tmp\/vendored-models /m,
    );
    expect(models).toContain('cp /tmp/vendored-models/*.onnx "$models"/');
    expect(models).toContain("python fetch_models.py");
    expect(models).toContain("sha256sum -c /app/models.sha256");
    expect(models).toContain("chown -R 0:0 /out");
    expect(models).toContain("touch -h -d @0");
    // No RUN names a host to download from.
    expect(
      instructions(ai).filter(
        (line) => /^RUN /.test(line) && /https?:\/\//i.test(line),
      ),
    ).toEqual([]);
  });

  it("version exactly the weights the wheel does not ship, with the pinned hashes", () => {
    const manifest = Object.fromEntries(
      read("infra/ai-ocr/models.sha256")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => {
          const [sha, name] = line.split(/\s+/);

          return [name, sha] as const;
        }),
    );
    const dir = resolve(ROOT, "infra/ai-ocr/models");
    const vendored = readdirSync(dir).sort();

    // The wheel (rapidocr 3.9.2) ships the PP-OCRv6 pair and the
    // classifier; the receipt profile's PP-OCRv5 pair is ours to carry.
    expect(vendored).toEqual([
      "ch_PP-OCRv5_det_mobile.onnx",
      "latin_PP-OCRv5_rec_mobile.onnx",
    ]);

    for (const name of vendored) {
      const sha = createHash("sha256")
        .update(readFileSync(resolve(dir, name)))
        .digest("hex");

      expect(sha, name).toBe(manifest[name]);
    }

    // Binary in git: never converted to CRLF, never diffed as text.
    expect(read(".gitattributes")).toMatch(/^\*\.onnx binary$/m);
  });

  it("copy the models as a linked layer, apart from the code that changes", () => {
    const app = stage(ai, "app");

    expect(app[0]).toBe("FROM base AS app");
    expect(app[1]).toBe("COPY --link --from=models /out/ /");
    // server.py alone, last: editing it re-ships a few KB.
    expect(app[app.length - 1]).toBe("COPY --link server.py ./");
    expect(app.filter((line) => /server\.py/.test(line))).toHaveLength(1);
  });

  it("build the runtime as the last stage, from the same app the tests ran on", () => {
    const all = instructions(ai);
    const froms = all.filter((line) => /^FROM /i.test(line));

    // compose.development.yaml and tests/ai-local build without --target.
    expect(froms[froms.length - 1]).toBe("FROM app AS runtime");
    expect(froms).toContain("FROM app AS test");
  });
});

describe.each([
  ["infra/ai-ocr/Dockerfile", ai, "runtime"],
  ["Dockerfile", api, "runner"],
])("%s carries its commit", (_, dockerfile, last) => {
  it("as APP_COMMIT_SHA, from a GIT_SHA build arg declared after the last RUN", () => {
    const lines = stage(dockerfile, last);
    const arg = lines.indexOf('ARG GIT_SHA=""');
    const lastRun = lines.map((line) => /^RUN /.test(line)).lastIndexOf(true);

    expect(arg).toBeGreaterThan(-1);
    expect(arg).toBeGreaterThan(lastRun);
    expect(lines[arg + 1]).toBe("ENV APP_COMMIT_SHA=${GIT_SHA}");
    // Nowhere else: an earlier ARG would be in the cache key of every RUN.
    expect(
      instructions(dockerfile).filter((line) => /GIT_SHA/.test(line)),
    ).toHaveLength(2);
  });
});

describe("the API image's build stage", () => {
  it("generates the Prisma client from the schema alone, before the source arrives", () => {
    const builder = stage(api, "builder");
    const generate = builder.indexOf("RUN yarn prisma generate");
    const source = builder.indexOf("COPY . .");

    expect(generate).toBeGreaterThan(-1);
    expect(generate).toBeLessThan(source);
    expect(builder.slice(0, generate)).toContain(
      "COPY prisma/schema.prisma ./prisma/schema.prisma",
    );
    expect(
      builder.findIndex((line) => line.startsWith("RUN yarn build")),
    ).toBeGreaterThan(source);
  });

  // index.d.ts alone is ~7 MB, and tsup does not type-check.
  it("drops the generated typings right after generating, before the source", () => {
    const builder = stage(api, "builder");
    const generate = builder.indexOf("RUN yarn prisma generate");

    expect(builder[generate + 1]).toBe(
      "RUN find node_modules/.prisma -name '*.d.ts' -delete",
    );
    expect(generate + 1).toBeLessThan(builder.indexOf("COPY . ."));
  });

  // The seeds are the release step's: only the `migrate` stage copies
  // release/, back into its build/.
  it("moves the seeds out of build/, in the RUN that built them", () => {
    const builder = stage(api, "builder");

    expect(builder[builder.length - 1]).toBe(
      "RUN yarn build && mkdir release && mv build/seed.js build/import-violation-codes.js release/",
    );
    expect(read("tsup.config.ts")).toMatch(
      /seed: "\.\/infra\/scripts\/seed\.ts"/,
    );
    expect(read("tsup.config.ts")).toMatch(
      /"import-violation-codes": "\.\/infra\/scripts\/import-violation-codes\.ts"/,
    );
  });
});

/**
 * Two images from one Dockerfile (measured on 31/10/2026, Prisma 7.10.1):
 *
 * - the API image (stage `runner`): 239 MB unpacked, ~68 MB compressed —
 *   it was 431 MB and 114.8 MB with the Prisma CLI inside (docs/deploy.md).
 *   No CLI, no schema, no migrations, no seeds: it never migrates, and
 *   refuses to start on a database that lacks its build's last migration.
 * - the release image (stage `migrate`, trajetto-api-migrate): the API
 *   image plus the CLI's own tree (~170 MB unpacked), the schema, the
 *   migrations and the seeds, as layers on top — the server pulls only
 *   those to run the release step, once per deploy.
 *
 * And what the API image already was:
 * - Alpine plus the node binary: the Node image's npm, corepack, yarn and C
 *   headers no longer ride along under a whiteout, and only what the
 *   binaries link against is installed.
 * - That binary comes as a tree whose directories carry its own mtime, so
 *   the ~46 MB layer is the same blob in every build, cached or not.
 * - The installs drop what nothing loads (maps, typings, READMEs, @types,
 *   the exceljs browser bundle, the pglite of `prisma dev` and the query
 *   compilers of every database). Prisma 7 has no query engine: the client
 *   carries its own PostgreSQL compiler, and only the CLI's schema engine
 *   (`migrate deploy`) is a native binary.
 * - The runner copies the most stable first: a source-only commit re-ships
 *   build/ alone (~1 MB compressed), never node_modules.
 *
 * Both images run before the push (deploy.yml, "Smoke test the API image"):
 * the API refusing the empty database, the release image migrating it from
 * scratch with the seeds, and the API's boot on top.
 */
describe("the API image's runtime base", () => {
  it("is the Alpine minor the node binary was built for", () => {
    const node =
      /^FROM node:[\d.]+-alpine(\d+\.\d+)@sha256:[0-9a-f]{64} AS node$/m.exec(
        api,
      )?.[1];
    const alpine =
      /^FROM alpine:(\d+\.\d+)\.\d+@sha256:[0-9a-f]{64} AS base$/m.exec(
        api,
      )?.[1];

    expect(node, "FROM node:<versão>-alpine<minor>@sha256:… AS node").toMatch(
      /^\d+\.\d+$/,
    );
    expect(alpine).toBe(node);
  });

  it("takes only the node binary from the Node image, as a reproducible tree", () => {
    const all = instructions(api);

    expect(all.filter((line) => /^FROM /.test(line))).toEqual([
      expect.stringMatching(/^FROM node:\S+ AS node$/),
      "FROM node AS node-binary",
      expect.stringMatching(/^FROM alpine:\S+ AS base$/),
      "FROM node AS deps",
      "FROM node AS builder",
      "FROM node AS prod-deps",
      "FROM node AS migrate-deps",
      "FROM base AS runner",
      "FROM runner AS migrate",
      // The default target: a build without --target is the API image.
      "FROM runner",
    ]);
    // Its directories take the binary's mtime: stamped with the build's
    // time, every uncached build made a new blob of the same binary.
    expect(stage(api, "node-binary").slice(1)).toEqual([
      "RUN mkdir -p /out/usr/local/bin && cp -p /usr/local/bin/node /out/usr/local/bin/node && touch -h -r /usr/local/bin/node /out/usr/local/bin /out/usr/local /out/usr",
    ]);
    expect(all.filter((line) => /--from=node/.test(line))).toEqual([
      "COPY --link --from=node-binary /out/ /",
    ]);
  });

  it("installs only what node, bcrypt and the Prisma schema engine link against", () => {
    const base = stage(api, "base");

    expect(base).toContain(
      "RUN apk upgrade --no-cache libcrypto3 libssl3 && apk add --no-cache ca-certificates dumb-init libssl3 libstdc++",
    );
    // Nothing here is linked against glibc, nothing calls procps, and
    // Prisma finds libssl.so.3 without the openssl binary (measured).
    expect(instructions(api).join("\n")).not.toMatch(
      /libc6-compat|gcompat|procps|apk add[^\n]* openssl\b/,
    );

    const runner = stage(api, "runner");

    expect(runner).toContain("USER nodejs");
    expect(runner).toContain('ENTRYPOINT ["dumb-init", "--"]');
  });
});

/** The `node -e '…'` that writes a stage's manifest, run on package.json. */
function derivedManifest(stageName: string) {
  const install = stage(api, stageName).find((line) =>
    /yarn install --pure-lockfile/.test(line),
  );
  const script = /node -e '([^']*)'/.exec(install ?? "")?.[1];

  expect(script, `${stageName}: node -e '…'`).toBeDefined();

  const box = sandbox();

  try {
    box.file("package.json", read("package.json"));

    const result = spawnSync("node", ["-e", script as string], {
      cwd: box.root,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);

    return JSON.parse(readFileSync(`${box.root}/package.json`, "utf8")) as {
      name?: string;
      private: boolean;
      dependencies: Record<string, string>;
      devDependencies?: unknown;
    };
  } finally {
    box.dispose();
  }
}

describe("the two installs, from manifests derived from package.json", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("keep the Prisma CLI a devDependency, never a dependency of the API", () => {
    expect(pkg.dependencies.prisma).toBeUndefined();
    expect(pkg.devDependencies.prisma).toBe(pkg.dependencies["@prisma/client"]);
  });

  // With the full manifest, `--production` still installed `prisma` and
  // `typescript` — devDependencies that are optional peers of
  // @prisma/client — and the whole CLI with them (measured: 317 → 91 MB).
  it("give the API image `dependencies` alone", () => {
    const manifest = derivedManifest("prod-deps");

    expect(manifest.dependencies).toEqual(pkg.dependencies);
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("give the release image the CLI and exactly what prisma.config.ts imports, at the repository's versions", () => {
    const imported = [
      ...read("prisma.config.ts").matchAll(/^import .* from "([^"]+)";$/gm),
    ].map(([, from]) =>
      from.startsWith("@")
        ? from.split("/").slice(0, 2).join("/")
        : from.split("/")[0],
    );
    const manifest = derivedManifest("migrate-deps");

    expect(Object.keys(manifest.dependencies).sort()).toEqual(
      [...new Set(["prisma", ...imported])].sort(),
    );
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(version, name).toBe(
        pkg.dependencies[name] ?? pkg.devDependencies[name],
      );
    }
  });

  // `--frozen-lockfile` refuses a manifest smaller than the lockfile, and a
  // plain install would rewrite it: `--pure-lockfile` installs every
  // version as the repository's yarn.lock has it, and never writes it.
  it("install from the repository's yarn.lock as it is", () => {
    for (const name of ["prod-deps", "migrate-deps"]) {
      const lines = stage(api, name);

      expect(lines, name).toContain("COPY package.json yarn.lock ./");
      expect(
        lines.find((line) => /yarn install /.test(line)),
        name,
      ).toMatch(/yarn install --pure-lockfile --production=true/);
    }
  });
});

describe("the API image's node_modules", () => {
  it("prune what nothing loads at run time, in the stage that is not shipped", () => {
    const prodDeps = stage(api, "prod-deps");

    expect(prodDeps[prodDeps.length - 1]).toBe(
      "RUN find node_modules -type f \\( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname '*.md' -o -iname '*.markdown' \\) -delete && " +
        "rm -rf node_modules/@types node_modules/exceljs/dist && " +
        "rm -r node_modules/@prisma/client/runtime/query_compiler_*",
    );
    // Nothing deletes in the runner: a later layer would only hide files.
    expect(
      stage(api, "runner").filter((line) => /^RUN .*\brm\b/.test(line)),
    ).toEqual([]);
  });

  it("leave no query engine for the Prisma CLI to point at (Prisma 7)", () => {
    // Prisma 6 shipped a musl query engine and the CLI took the client's
    // through PRISMA_QUERY_ENGINE_LIBRARY; Prisma 7 has none, and the schema
    // has no binaryTargets to name one.
    expect(api).not.toMatch(/PRISMA_QUERY_ENGINE_LIBRARY|libquery_engine/);
    expect(read("prisma/schema.prisma")).not.toMatch(/^\s*binaryTargets\s*=/m);
  });

  it("copy the most stable first, build/ last, and nothing the release step needs", () => {
    const runner = stage(api, "runner");

    expect(runner.filter((line) => /^COPY /.test(line))).toEqual([
      "COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules",
      "COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma",
      "COPY --from=builder --chown=nodejs:nodejs /app/infra/scripts/docker-entrypoint.sh ./docker-entrypoint.sh",
      "COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json",
      "COPY --from=builder --chown=nodejs:nodejs /app/build/src/modules ./src/modules",
      "COPY --from=builder --chown=nodejs:nodejs /app/build ./build",
    ]);
    // The entrypoint's RUN sits before the layers a commit changes, so it
    // stays cached (a re-run makes a new blob: the file's mtime).
    expect(runner.findIndex((line) => line.startsWith("RUN sed"))).toBeLessThan(
      runner.indexOf(
        "COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json",
      ),
    );
  });
});

describe("the release image (trajetto-api-migrate)", () => {
  it("adds the CLI, the schema, the migrations and the seeds on top of the API image, most stable first", () => {
    const migrate = stage(api, "migrate");

    expect(migrate[0]).toBe("FROM runner AS migrate");
    expect(migrate.filter((line) => /^COPY /.test(line))).toEqual([
      "COPY --from=migrate-deps --chown=nodejs:nodejs /migrate/node_modules ./migrate/node_modules",
      "COPY --from=builder --chown=nodejs:nodejs /app/tabela-codigo-infracoes-renainf-xlsx.xlsx ./tabela-codigo-infracoes-renainf-xlsx.xlsx",
      "COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./migrate/prisma.config.ts",
      "COPY --from=builder --chown=nodejs:nodejs /app/prisma/schema.prisma ./migrate/prisma/schema.prisma",
      "COPY --from=builder --chown=nodejs:nodejs /app/prisma/migrations ./migrate/prisma/migrations",
      "COPY --from=builder --chown=nodejs:nodejs /app/release/ ./build/",
    ]);
    // A later layer would only hide files: nothing runs or deletes here.
    expect(migrate.filter((line) => /^RUN /.test(line))).toEqual([]);
  });

  // The API's probe of :3333 would have Swarm kill the job mid-migration.
  it("declares no healthcheck, and migrates by default", () => {
    const migrate = stage(api, "migrate");

    expect(migrate).toContain("HEALTHCHECK NONE");
    expect(migrate[migrate.length - 1]).toBe(
      'CMD ["./docker-entrypoint.sh", "migrate"]',
    );
  });

  it("keeps the release image's CLI apart from the API's node_modules", () => {
    // The entrypoint runs `prisma migrate deploy` from migrate/, where
    // prisma.config.ts resolves its imports in migrate/node_modules.
    expect(read("infra/scripts/docker-entrypoint.sh")).toMatch(
      /\[ -x migrate\/node_modules\/\.bin\/prisma \]/,
    );
  });
});

/**
 * The prunes' effect, not only their text: each install stage's last RUN,
 * executed by sh on a tree laid out like the Prisma 7.10.1 install. With
 * `rm -rf` and globs, a Prisma bump that moved pglite or renamed the
 * compilers was a silent no-op that put them back in an image; the build
 * must stop there instead.
 */
describe.skipIf(!hasShell("sh"))("the prunes, run on a tree", () => {
  const CASES = {
    "prod-deps": {
      removed: [
        "node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.js",
        "node_modules/@prisma/client/runtime/query_compiler_small_bg.mysql.mjs",
        "node_modules/@types/node/index.d.ts",
        "node_modules/exceljs/dist/exceljs.min.js",
        "node_modules/pg/lib/index.js.map",
        "node_modules/pg/README.md",
      ],
      // What the API loads: the client, pg, ExcelJS's main.
      kept: [
        "node_modules/@prisma/client/runtime/client.js",
        "node_modules/pg/lib/index.js",
        "node_modules/exceljs/lib/exceljs.nodejs.js",
      ],
    },
    "migrate-deps": {
      removed: [
        "node_modules/@electric-sql/pglite/dist/index.js",
        "node_modules/prisma/build/query_compiler_fast_bg.postgresql.wasm",
        "node_modules/prisma/build/index.js.map",
        "node_modules/prisma/README.md",
      ],
      // What `migrate deploy` loads: the CLI, its schema engine and Studio
      // (the CLI requires it when it starts).
      kept: [
        "node_modules/prisma/build/index.js",
        "node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x",
        "node_modules/@prisma/studio-core/data/bff.js",
        "node_modules/@prisma/dev/dist/index.js",
      ],
    },
  } as const;

  let box: Sandbox | undefined;

  afterEach(() => {
    box?.dispose();
    box = undefined;
  });

  function prune(stageName: keyof typeof CASES, files: string[]) {
    const lines = stage(api, stageName);
    const command = lines[lines.length - 1].replace(/^RUN /, "");

    box = sandbox();
    for (const file of files) box.file(file, "x");

    const result = spawnSync("sh", ["-c", command], {
      cwd: box.root,
      encoding: "utf8",
      timeout: 30_000,
    });
    const root = box.root;

    return {
      status: result.status,
      stderr: result.stderr ?? "",
      exists: (file: string) => existsSync(`${root}/${file}`),
    };
  }

  it.each(Object.keys(CASES) as (keyof typeof CASES)[])(
    "%s removes every target and keeps what its image loads",
    (name) => {
      const { removed, kept } = CASES[name];
      const { status, stderr, exists } = prune(name, [...removed, ...kept]);

      expect(status, stderr).toBe(0);
      expect(removed.filter(exists)).toEqual([]);
      expect(kept.filter((file) => !exists(file))).toEqual([]);
    },
  );

  it.each([
    [
      "prod-deps",
      "the client's compilers renamed",
      "node_modules/@prisma/client/runtime/query_compiler_",
      "node_modules/@prisma/client/runtime/query_planner_",
      "node_modules/@prisma/client/runtime/query_compiler_*",
    ],
    [
      "migrate-deps",
      "pglite moved under the CLI",
      "node_modules/@electric-sql/pglite/dist/index.js",
      "node_modules/prisma/node_modules/@electric-sql/pglite/dist/index.js",
      "node_modules/@electric-sql/pglite",
    ],
    [
      "migrate-deps",
      "the CLI's compilers renamed",
      "node_modules/prisma/build/query_compiler_",
      "node_modules/prisma/build/query_planner_",
      "node_modules/prisma/build/query_compiler_*",
    ],
  ] as const)(
    "%s stops the build when %s",
    (name, _case, from, to, missing) => {
      const { removed, kept } = CASES[name];
      const original = [...removed, ...kept];
      const files = original.map((file) =>
        file.startsWith(from) ? to + file.slice(from.length) : file,
      );

      expect(files).not.toEqual(original);

      const { status, stderr } = prune(name, files);

      expect(status).not.toBe(0);
      expect(stderr).toContain(missing);
    },
  );
});

/**
 * The Prisma schema engine `migrate deploy` runs comes from @prisma/engines'
 * postinstall, which downloads it from binaries.prisma.sh and fails
 * SILENTLY: a dead download left no engine, and nothing said so until a
 * migrate without network. The install that ships it (migrate-deps) checks
 * it in the same RUN, tries the download again, and stops the build with
 * the cause. Executed by sh on a tree, with the manifest step and yarn
 * replaced and the postinstall faked.
 */
describe.skipIf(!hasShell("sh"))(
  "the release image's schema engine check, run on a tree",
  () => {
    let box: Sandbox | undefined;

    afterEach(() => {
      box?.dispose();
      box = undefined;
    });

    const ENGINE_CHECK = /schema-engine-\*/;

    it("is in the install that ships the CLI, in the same RUN (a layer without the engine is never cached), and nowhere else", () => {
      const install = stage(api, "migrate-deps").find((line) =>
        /yarn install --pure-lockfile/.test(line),
      );

      expect(install).toMatch(ENGINE_CHECK);
      // Nothing in the build runs the schema engine, and the API image has
      // no CLI: a check there would only add a download that can fail.
      for (const name of ["deps", "builder", "prod-deps", "runner"]) {
        expect(
          stage(api, name).filter((line) => ENGINE_CHECK.test(line)),
          name,
        ).toEqual([]);
      }
    });

    function check(engine: boolean, downloads: boolean) {
      const install = stage(api, "migrate-deps").find((line) =>
        /yarn install --pure-lockfile/.test(line),
      ) as string;
      const command = install
        .replace(/^RUN --mount=\S+ /, "")
        .replace(
          /node -e '[^']*' && yarn install --pure-lockfile --production=\w+/,
          "true",
        )
        .replace(/sleep \$\(\(attempt \* 10\)\);/, "");

      box = sandbox();
      if (engine) {
        box.file(
          "node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x",
          "x",
        );
      }
      box.file(
        "node_modules/@prisma/engines/scripts/postinstall.js",
        downloads
          ? 'require("fs").writeFileSync(__dirname + "/../schema-engine-linux-musl-openssl-3.0.x", "x");'
          : "// the download failed, silently",
      );

      return spawnSync("sh", ["-c", command], {
        cwd: box.root,
        encoding: "utf8",
        timeout: 30_000,
      });
    }

    it("passes at once when the install left the engine", () => {
      const result = check(true, false);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("downloads it again when the install left nothing", () => {
      const result = check(false, true);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toMatch(
        /Prisma schema engine missing after the install \(attempt 1 of 3\)/,
      );
    });

    it("stops the build with the cause when it never gets it", () => {
      const result = check(false, false);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/attempt 3 of 3/);
      expect(result.stderr).toMatch(
        /was not downloaded from binaries\.prisma\.sh/,
      );
    });
  },
);
