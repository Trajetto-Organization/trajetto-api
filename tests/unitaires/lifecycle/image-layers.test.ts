import { spawnSync } from "node:child_process";
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
  it("fetch the models in a stage of their own, with fixed owner, mode and mtimes", () => {
    const models = stage(ai, "models").join("\n");

    expect(stage(ai, "models")[0]).toMatch(/^FROM base AS models$/);
    expect(models).toContain("python fetch_models.py");
    expect(models).toContain("sha256sum -c /app/models.sha256");
    expect(models).toContain("chown -R 0:0 /out");
    expect(models).toContain("touch -h -d @0");
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
    expect(builder.indexOf("RUN yarn build")).toBeGreaterThan(source);
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
});

/**
 * The API runtime (§14, measured on 28/10/2026 on Prisma 6.1 with the same
 * sources: 115 → 88 MB compressed, 417 → 285 MB unpacked; on Prisma 7.10.1,
 * whose CLI is larger, 114.8 MB compressed and 431 MB unpacked, as measured
 * in docs/deploy.md).
 *
 * - Alpine plus the node binary: the Node image's npm, corepack, yarn and C
 *   headers no longer ride along under a whiteout, and only what the
 *   binaries link against is installed.
 * - That binary comes as a tree whose directories carry its own mtime, so
 *   the ~46 MB layer is the same blob in every build, cached or not.
 * - prod-deps drops what nothing loads (maps, typings, READMEs, @types, the
 *   exceljs browser bundle, the pglite of `prisma dev` and the query
 *   compilers of every database). Prisma 7 has no query engine: the client
 *   carries its own PostgreSQL compiler, and only the CLI's schema engine
 *   (`migrate deploy`) is a native binary.
 * - The runner copies the most stable first: a source-only commit re-ships
 *   build/ alone (~1 MB compressed), never node_modules.
 *
 * The image itself runs before the push (deploy.yml, "Smoke test the API
 * image"): migrations from an empty database, the seeds and the boot.
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
      "FROM base AS runner",
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

describe("the API image's node_modules", () => {
  it("prune what nothing loads at run time, in the stage that is not shipped", () => {
    const prodDeps = stage(api, "prod-deps");

    expect(prodDeps[prodDeps.length - 1]).toBe(
      "RUN find node_modules -type f \\( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname '*.md' -o -iname '*.markdown' \\) -delete && " +
        "rm -rf node_modules/@types node_modules/exceljs/dist && " +
        "rm -r node_modules/@electric-sql/pglite " +
        "node_modules/@prisma/client/runtime/query_compiler_* " +
        "node_modules/prisma/build/query_compiler_*",
    );
    // The CLI requires Studio and @prisma/dev when it starts: without them
    // `migrate deploy` fails ("Cannot find module
    // '@prisma/studio-core/data/bff'", smoke-tested).
    expect(prodDeps.join(" ")).not.toMatch(/studio-core|@prisma\/dev\b/);
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

  it("copy the most stable first, and build/ last", () => {
    const runner = stage(api, "runner");

    expect(runner.filter((line) => /^COPY /.test(line))).toEqual([
      "COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules",
      "COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma",
      "COPY --from=builder --chown=nodejs:nodejs /app/tabela-codigo-infracoes-renainf-xlsx.xlsx ./tabela-codigo-infracoes-renainf-xlsx.xlsx",
      "COPY --from=builder --chown=nodejs:nodejs /app/infra/scripts/docker-entrypoint.sh ./docker-entrypoint.sh",
      "COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json",
      "COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma",
      "COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./prisma.config.ts",
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

/**
 * The prune's effect, not only its text: prod-deps' last RUN, executed by sh
 * on a tree laid out like the Prisma 7.10.1 install. With `rm -rf` and globs,
 * a Prisma bump that moved pglite or renamed the compilers was a silent no-op
 * that put them back in the image; the build must stop there instead.
 */
describe.skipIf(!hasShell("sh"))("the API image's prune, run on a tree", () => {
  const REMOVED = [
    "node_modules/@electric-sql/pglite/dist/index.js",
    "node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.js",
    "node_modules/@prisma/client/runtime/query_compiler_small_bg.mysql.mjs",
    "node_modules/prisma/build/query_compiler_fast_bg.postgresql.wasm",
    "node_modules/@types/node/index.d.ts",
    "node_modules/exceljs/dist/exceljs.min.js",
    "node_modules/pg/lib/index.js.map",
    "node_modules/pg/README.md",
  ];
  // What the image loads: the client, the CLI and the schema engine that
  // `migrate deploy` runs, Studio (the CLI requires it), pg, ExcelJS's main.
  const KEPT = [
    "node_modules/@prisma/client/runtime/client.js",
    "node_modules/prisma/build/index.js",
    "node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x",
    "node_modules/@prisma/studio-core/data/bff.js",
    "node_modules/pg/lib/index.js",
    "node_modules/exceljs/lib/exceljs.nodejs.js",
  ];

  let box: Sandbox | undefined;

  afterEach(() => {
    box?.dispose();
    box = undefined;
  });

  function prune(files: string[]) {
    const prodDeps = stage(api, "prod-deps");
    const command = prodDeps[prodDeps.length - 1].replace(/^RUN /, "");

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

  it("removes every target and keeps what the image loads", () => {
    const { status, stderr, exists } = prune([...REMOVED, ...KEPT]);

    expect(status, stderr).toBe(0);
    expect(REMOVED.filter(exists)).toEqual([]);
    expect(KEPT.filter((file) => !exists(file))).toEqual([]);
    expect(exists("node_modules/@electric-sql/pglite")).toBe(false);
  });

  it.each([
    [
      "pglite moved under the CLI",
      "node_modules/@electric-sql/pglite/dist/index.js",
      "node_modules/prisma/node_modules/@electric-sql/pglite/dist/index.js",
      "node_modules/@electric-sql/pglite",
    ],
    [
      "the client's compilers renamed",
      "node_modules/@prisma/client/runtime/query_compiler_",
      "node_modules/@prisma/client/runtime/query_planner_",
      "node_modules/@prisma/client/runtime/query_compiler_*",
    ],
    [
      "the CLI's compilers renamed",
      "node_modules/prisma/build/query_compiler_",
      "node_modules/prisma/build/query_planner_",
      "node_modules/prisma/build/query_compiler_*",
    ],
  ])("stops the build when %s", (_case, from, to, missing) => {
    const files = [...REMOVED, ...KEPT].map((file) =>
      file.startsWith(from) ? to + file.slice(from.length) : file,
    );

    expect(files).not.toEqual([...REMOVED, ...KEPT]);

    const { status, stderr } = prune(files);

    expect(status).not.toBe(0);
    expect(stderr).toContain(missing);
  });
});
