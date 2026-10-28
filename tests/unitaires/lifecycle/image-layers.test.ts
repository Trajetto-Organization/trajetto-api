import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

  it("install one requirements file per layer, in the order they change, hashes required", () => {
    const installs = stage(ai, "base").filter((line) =>
      /pip install/.test(line),
    );

    expect(installs).toEqual(
      LAYERS.map(
        (file) =>
          `RUN --mount=type=bind,source=${file},target=/tmp/requirements.txt pip install --require-hashes --no-deps -r /tmp/requirements.txt`,
      ),
    );
    // Bind-mounted, never COPY'd up front: one COPY of every file would put
    // each layer behind the most edited file.
    expect(
      stage(ai, "base").some((line) => /^COPY .*requirements/.test(line)),
    ).toBe(false);
    expect([...runtimeFiles].sort()).toEqual([...LAYERS].sort());
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
});
