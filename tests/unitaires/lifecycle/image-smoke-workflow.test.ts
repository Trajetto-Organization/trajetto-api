import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * The AI image runs before it is pushed (§14/§19: smoke test of the final
 * image).
 *
 * The `ai-ocr` job runs pytest in the `test` stage, never the runtime stage
 * that ships: the first run of the shipped image was the staging deploy.
 * build-and-push now loads that image into the runner, starts it offline
 * with a read-only root, waits for its own HEALTHCHECK (both OCR profiles
 * loaded and read warmup.jpg), checks the commit it reports, and only then
 * pushes — the same build, from the builder's cache. A reused image skips
 * both steps: it passed them when it was built.
 *
 * The step's `run:` block is executed with docker, openssl, sleep and seq
 * stubbed: a list of canned container states stands in for the daemon.
 */
const workflow = readFileSync(
  resolve(process.cwd(), ".github", "workflows", "deploy.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

const job = (() => {
  const start = workflow.indexOf("\n  build-and-push:");
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
})();

const steps = job
  .split(/\n {6}- name: /)
  .slice(1)
  .map((chunk) => ({ name: chunk.split("\n")[0], text: chunk }));

const stepText = (name: string) =>
  steps.find((step) => step.name === name)?.text ?? "";

const SMOKE_BUILD = "Build the AI image for the smoke test";
const SMOKE = "Smoke test the AI image";
const PUSH = "Build and push the AI image";

/** A build step's `with:` inputs; block values keep their lines. */
function inputs(text: string): Record<string, string> {
  const lines = text.split("\n");
  const values: Record<string, string> = {};
  let key = "";

  for (const line of lines.slice(
    lines.findIndex((each) => /^ {8}with:$/.test(each)) + 1,
  )) {
    const entry = /^ {10}([\w-]+):\s*(.*)$/.exec(line);

    if (entry) {
      key = entry[1];
      values[key] = entry[2];
    } else if (/^ {12}\S/.test(line) && key) {
      values[key] += `\n${line.trim()}`;
    } else if (!/^ {10}#/.test(line) && line.trim() !== "") {
      break;
    }
  }

  return values;
}

/** The `run: |` block of a step, dedented. */
function runBlock(name: string): string {
  const lines = stepText(name).split("\n");
  const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));

  expect(at, `${name}: run`).toBeGreaterThan(-1);

  const indent = lines[at].search(/\S/) + 2;
  const body: string[] = [];

  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;

    body.push(line.slice(indent));
  }

  return body.join("\n");
}

describe("the AI image's smoke test, in build-and-push", () => {
  it("runs after the metadata and before the push, only when the image is built", () => {
    const names = steps.map((step) => step.name);

    expect(names.indexOf(SMOKE_BUILD)).toBe(
      names.indexOf("Extract metadata (ai)") + 1,
    );
    expect(names.indexOf(SMOKE)).toBe(names.indexOf(SMOKE_BUILD) + 1);
    expect(names.indexOf(PUSH)).toBe(names.indexOf(SMOKE) + 1);

    for (const name of [SMOKE_BUILD, SMOKE]) {
      expect(stepText(name), name).toContain(
        "if: steps.ai-source.outputs.build == 'true'",
      );
    }
  });

  it("loads the very build the push publishes, and publishes nothing itself", () => {
    const smoke = inputs(stepText(SMOKE_BUILD));
    const push = inputs(stepText(PUSH));

    expect(smoke.push).toBe("false");
    expect(smoke.load).toBe("true");

    // No attestations (the classic image store cannot load them) and no
    // cache export (the push writes it).
    for (const key of ["sbom", "provenance", "cache-to"]) {
      expect(smoke[key], key).toBeUndefined();
    }

    // The same inputs: the push finds every layer in the builder's cache.
    for (const key of [
      "context",
      "target",
      "build-args",
      "cache-from",
      "labels",
    ]) {
      expect(smoke[key], key).toBe(push[key]);
    }

    expect(push.push).toBe("true");
  });

  it("starts it offline, read-only, with a throwaway token and no secret", () => {
    const script = runBlock(SMOKE);

    expect(script).toContain(
      "docker run -d --network none --read-only --tmpfs /tmp",
    );
    // The token goes by name (-e AI_TOKEN), never on the command line.
    expect(script).toMatch(/-e AI_TOKEN "\$IMAGE"/);
    expect(stepText(SMOKE)).not.toContain("secrets.");

    // It polls for longer than the start period it gives the container.
    const start = Number(/--health-start-period (\d+)s/.exec(script)?.[1]);
    const polls = Number(/for _ in \$\(seq 1 (\d+)\)/.exec(script)?.[1]);
    const pause = Number(/\n\s+sleep (\d+)\n/.exec(script)?.[1]);

    expect(polls * pause).toBeGreaterThan(start);
  });
});

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const TOKEN = "f".repeat(64);
const last = (calls: string[]) => calls[calls.length - 1];

describe.skipIf(!hasShell("bash"))(
  "the AI smoke test, run with docker stubbed",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      // `inspect` answers the canned states in order, the last one for good
      // (shell builtins only: every process is slow on Windows).
      box.stub(
        "docker",
        [
          'case "$1" in',
          "  run) echo cid-ai ;;",
          "  inspect)",
          `    n=1; [ -f "${box.root}/n" ] && read -r n < "${box.root}/n"`,
          "    at=0",
          "    while IFS= read -r line; do",
          '      at=$((at + 1)); state="$line"',
          '      [ "$at" -ge "$n" ] && break',
          `    done < "${box.root}/states"`,
          `    echo $((n + 1)) > "${box.root}/n"`,
          '    echo "$state" ;;',
          `  exec) cat "${box.root}/commit" ;;`,
          "  logs) echo 'ai: warm-up log line' ;;",
          "esac",
        ].join("\n"),
      );
      box.stub("openssl", `echo ${TOKEN}`);
      box.stub("sleep", "exit 0");
      // Three polls instead of 75; the real budget is checked on the text.
      box.stub("seq", "echo 1 2 3");
    });

    afterEach(() => box.dispose());

    function smoke(states: string[], commit = SHA) {
      writeFileSync(`${box.root}/states`, `${states.join("\n")}\n`);
      writeFileSync(`${box.root}/commit`, `${commit}\n`);

      const summary = `${box.root}/summary`;

      writeFileSync(summary, "");

      const script = box.file(
        "step.sh",
        `set -eo pipefail\n${runBlock(SMOKE)}`,
      );
      const result = run("bash", script, [], {
        bin: box.bin,
        env: {
          GITHUB_SHA: SHA,
          GITHUB_STEP_SUMMARY: summary,
          IMAGE: "trajetto-ai:smoke",
        },
      });

      return {
        ...result,
        output: `${result.stdout}${result.stderr}`,
        summary: readFileSync(summary, "utf8"),
        docker: box.calls("docker"),
      };
    }

    it("passes an image that turns healthy offline and reports this commit", () => {
      const result = smoke(["running/starting", "running/healthy"]);

      expect(result.status, result.output).toBe(0);
      expect(result.summary).toContain("smoke test OK");
      expect(result.docker[0]).toBe(
        "docker run -d --network none --read-only --tmpfs /tmp --health-interval 2s --health-start-period 120s -e AI_TOKEN trajetto-ai:smoke",
      );
      // The token never reaches a command line (or the log).
      expect(result.docker.join("\n")).not.toContain(TOKEN);
      expect(last(result.docker)).toBe("docker rm -f cid-ai");
    });

    it("fails, with the container's log, when it exits or turns unhealthy", () => {
      for (const state of ["exited/unhealthy", "running/unhealthy"]) {
        const result = smoke(["running/starting", state]);

        expect(result.status, state).toBe(1);
        expect(result.output).toContain(
          `::error::Smoke test da imagem trajetto-ai: o container não ficou saudável (${state})`,
        );
        // The API image was pushed earlier in this job: the message names
        // only what the failure kept out of GHCR.
        expect(result.output).toContain(
          "A imagem da IA não foi publicada no GHCR",
        );
        expect(result.output).not.toContain("Nada foi publicado");
        expect(result.output).toContain("ai: warm-up log line");
        expect(result.summary).toBe("");
        expect(last(result.docker)).toBe("docker rm -f cid-ai");
      }
    });

    it("fails when it never leaves starting, or reports another commit", () => {
      const stuck = smoke(["running/starting"]);

      expect(stuck.status).toBe(1);
      expect(stuck.output).toContain("(running/starting)");

      const other = smoke(["running/healthy"], "0".repeat(40));

      expect(other.status).toBe(1);
      expect(other.output).toContain("/health informou o commit");
      expect(last(other.docker)).toBe("docker rm -f cid-ai");
    });
  },
);

/**
 * The API image runs before it is pushed, too (§14/§19), with the release
 * image built on top of it.
 *
 * Its liveness touches nothing, but the entrypoint waits for Postgres and
 * checks the schema before the server starts, so the smoke test brings a
 * throwaway Postgres and Redis on an internal network (no route out: the
 * Prisma CLI must not download an engine) and runs both images the way a
 * deploy does: the API image refusing the empty database, the release image
 * (`migrate`, from an empty database), and the API image's boot on the
 * result — before the pushes publish the same builds.
 */
const API_SMOKE_BUILD = "Build the API image for the smoke test";
const RELEASE_SMOKE_BUILD = "Build the release image for the smoke test";
const API_SMOKE = "Smoke test the API image";
const API_PUSH = "Build and push Docker image";
const RELEASE_PUSH = "Build and push the release image";

/** A step's `env:` values (one line each). */
function stepEnv(name: string): Record<string, string> {
  const lines = stepText(name).split("\n");
  const values: Record<string, string> = {};

  for (const line of lines.slice(
    lines.findIndex((each) => /^ {8}env:$/.test(each)) + 1,
  )) {
    const entry = /^ {10}([A-Z_]+): (\S+)$/.exec(line);

    if (entry) values[entry[1]] = entry[2];
    else if (!/^ {10}#/.test(line)) break;
  }

  return values;
}

describe("the API image's smoke test, in build-and-push", () => {
  it("runs after the metadata and before the pushes, on every build", () => {
    const names = steps.map((step) => step.name);

    expect(names.indexOf(API_SMOKE_BUILD)).toBe(
      names.indexOf("Extract metadata (release image)") + 1,
    );
    expect(names.indexOf("Extract metadata (release image)")).toBe(
      names.indexOf("Extract metadata") + 1,
    );
    expect(names.indexOf(RELEASE_SMOKE_BUILD)).toBe(
      names.indexOf(API_SMOKE_BUILD) + 1,
    );
    expect(names.indexOf(API_SMOKE)).toBe(
      names.indexOf(RELEASE_SMOKE_BUILD) + 1,
    );
    expect(names.indexOf(API_PUSH)).toBe(names.indexOf(API_SMOKE) + 1);
    expect(names.indexOf(RELEASE_PUSH)).toBe(names.indexOf(API_PUSH) + 1);

    for (const name of [API_SMOKE_BUILD, RELEASE_SMOKE_BUILD, API_SMOKE]) {
      expect(stepText(name), name).not.toMatch(/^ {8}if:/m);
    }
  });

  it.each([
    [API_SMOKE_BUILD, API_PUSH, "runner"],
    [RELEASE_SMOKE_BUILD, RELEASE_PUSH, "migrate"],
  ])(
    "%s loads the very build the push publishes, and publishes nothing itself",
    (smokeName, pushName, target) => {
      const smoke = inputs(stepText(smokeName));
      const push = inputs(stepText(pushName));

      expect(smoke.push).toBe("false");
      expect(smoke.load).toBe("true");
      expect(smoke.target).toBe(target);

      for (const key of ["sbom", "provenance", "cache-to"]) {
        expect(smoke[key], key).toBeUndefined();
      }

      for (const key of [
        "context",
        "file",
        "target",
        "build-args",
        "cache-from",
        "labels",
      ]) {
        expect(smoke[key], key).toBe(push[key]);
      }

      expect(push.push).toBe("true");
    },
  );

  it("brings its own Postgres and Redis, pinned, on a network with no way out", () => {
    const script = runBlock(API_SMOKE);
    const env = stepEnv(API_SMOKE);

    expect(script).toContain('docker network create --internal "$net"');
    // The majors production and the `test` job run.
    expect(env.POSTGRES_IMAGE).toMatch(
      /^postgres:16-alpine@sha256:[0-9a-f]{64}$/,
    );
    expect(env.REDIS_IMAGE).toMatch(/^redis:7-alpine@sha256:[0-9a-f]{64}$/);
    expect(env.IMAGE).toBe("trajetto-api:smoke");
    expect(env.MIGRATE_IMAGE).toBe("trajetto-api-migrate:smoke");
    expect(stepText(API_SMOKE)).not.toContain("secrets.");
    // Values go through a private env file, never a command line.
    expect(script).toContain("umask 077");
    expect(script).not.toMatch(/docker run[^\n]* -e (JWT|MASTER|DATABASE)/);

    const start = Number(/--health-start-period (\d+)s/.exec(script)?.[1]);
    const polls = Number(/for _ in \$\(seq 1 (\d+)\)/.exec(script)?.[1]);
    const pause = Number(/\n\s+sleep (\d+)\n/.exec(script)?.[1]);

    expect(polls * pause).toBeGreaterThan(start);
  });
});

describe.skipIf(!hasShell("bash"))(
  "the API smoke test, run with docker stubbed",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      // `run` tells the containers apart by their arguments and keeps a
      // copy of the env file it was handed; `wait` and `logs` answer for the
      // API that must refuse the empty database; `inspect` answers the
      // canned states in order, the last one for good.
      box.stub(
        "docker",
        [
          'case "$1" in',
          "  run)",
          '    prev=""',
          '    for arg in "$@"; do',
          `      [ "$prev" = "--env-file" ] && cp "$arg" "${box.root}/env-seen"`,
          '      prev="$arg"',
          "    done",
          '    case "$*" in',
          `      *'--entrypoint sh'*) read -r rc < "${box.root}/content-rc"; exit "$rc" ;;`,
          "      *postgres:16-alpine*) echo cid-pg ;;",
          "      *redis:7-alpine*) echo cid-redis ;;",
          "      *trajetto-api-migrate:smoke*)",
          "        echo 'migrate: 136 migrations, seeds ok'",
          `        read -r rc < "${box.root}/migrate-rc"; exit "$rc" ;;`,
          "      *--health-interval*) echo cid-api ;;",
          "      *) echo cid-guard ;;",
          "    esac ;;",
          "  wait)",
          `    read -r rc < "${box.root}/guard-rc"`,
          '    [ "$rc" = hang ] && exit 124',
          '    echo "$rc" ;;',
          "  inspect)",
          `    n=1; [ -f "${box.root}/n" ] && read -r n < "${box.root}/n"`,
          "    at=0",
          "    while IFS= read -r line; do",
          '      at=$((at + 1)); state="$line"',
          '      [ "$at" -ge "$n" ] && break',
          `    done < "${box.root}/states"`,
          `    echo $((n + 1)) > "${box.root}/n"`,
          '    echo "$state" ;;',
          "  exec)",
          '    case "$*" in',
          `      *readiness*) read -r rc < "${box.root}/ready-rc"; exit "$rc" ;;`,
          `      *) cat "${box.root}/commit" ;;`,
          "    esac ;;",
          "  logs)",
          '    case "$*" in',
          `      *cid-guard*) cat "${box.root}/guard-log" ;;`,
          "      *) echo 'api: boot log line' ;;",
          "    esac ;;",
          "esac",
        ].join("\n"),
      );
      box.stub("openssl", `echo ${TOKEN}`);
      box.stub("sleep", "exit 0");
      box.stub("seq", "echo 1 2 3");
    });

    afterEach(() => box.dispose());

    const REFUSAL =
      "🔴 O banco não tem a migration 20261028140100_import_reversal_progress, que este build exige";

    function smoke({
      content = 0,
      guard = "1",
      guardLog = REFUSAL,
      states = ["running/starting", "running/healthy"],
      migrate = 0,
      ready = 0,
      commit = SHA,
    }: {
      content?: number;
      guard?: string;
      guardLog?: string;
      states?: string[];
      migrate?: number;
      ready?: number;
      commit?: string;
    } = {}) {
      writeFileSync(`${box.root}/n`, "1\n");
      writeFileSync(`${box.root}/content-rc`, `${content}\n`);
      writeFileSync(`${box.root}/guard-rc`, `${guard}\n`);
      writeFileSync(`${box.root}/guard-log`, `${guardLog}\n`);
      writeFileSync(`${box.root}/states`, `${states.join("\n")}\n`);
      writeFileSync(`${box.root}/migrate-rc`, `${migrate}\n`);
      writeFileSync(`${box.root}/ready-rc`, `${ready}\n`);
      writeFileSync(`${box.root}/commit`, `${commit}\n`);

      const summary = `${box.root}/summary`;

      writeFileSync(summary, "");

      const script = box.file(
        "step.sh",
        `set -eo pipefail\n${runBlock(API_SMOKE)}`,
      );
      const result = run("bash", script, [], {
        bin: box.bin,
        env: {
          ...stepEnv(API_SMOKE),
          GITHUB_SHA: SHA,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_RUN_ID: "77",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_TEMP: box.root,
        },
      });

      return {
        ...result,
        output: `${result.stdout}${result.stderr}`,
        summary: readFileSync(summary, "utf8"),
        docker: box.calls("docker"),
      };
    }

    const cleanup = [
      "docker rm -f cid-api",
      "docker rm -f cid-guard",
      "docker rm -f cid-pg",
      "docker rm -f cid-redis",
      "docker network rm api-smoke-77-1",
    ];

    it("checks what the API image leaves out, sees it refuse the empty database, migrates it, then boots healthy, on this commit and ready", () => {
      const result = smoke();
      const envFile = `${box.root}/api-smoke.env`;

      expect(result.status, result.output).toBe(0);
      expect(result.summary).toContain("trajetto-api: smoke test OK");
      expect(result.docker.slice(0, 9)).toEqual([
        expect.stringMatching(
          /^docker run --rm --entrypoint sh trajetto-api:smoke -c test ! -e node_modules\/prisma && test ! -e node_modules\/@prisma\/engines && test ! -e prisma && test ! -e prisma\.config\.ts && test ! -e build\/seed\.js && test -f build\/schema-version\.json$/,
        ),
        "docker network create --internal api-smoke-77-1",
        expect.stringMatching(
          /^docker run -d --network api-smoke-77-1 --network-alias postgres -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=trajetto postgres:16-alpine@sha256:/,
        ),
        expect.stringMatching(
          /^docker run -d --network api-smoke-77-1 --network-alias redis redis:7-alpine@sha256:/,
        ),
        `docker run -d --network api-smoke-77-1 --env-file ${envFile} trajetto-api:smoke`,
        "docker wait cid-guard",
        "docker logs cid-guard",
        `docker run --rm --network api-smoke-77-1 --env-file ${envFile} trajetto-api-migrate:smoke`,
        `docker run -d --network api-smoke-77-1 --env-file ${envFile} --health-interval 2s --health-start-period 120s trajetto-api:smoke`,
      ]);
      expect(result.docker).toContain(
        "docker exec cid-api wget -q -O /dev/null http://127.0.0.1:3333/health/readiness",
      );
      expect(result.docker.slice(-5)).toEqual(cleanup);

      // What the images got: the database they may bootstrap, random keys.
      const seen = readFileSync(`${box.root}/env-seen`, "utf8");

      expect(seen).toContain(
        "DATABASE_URL=postgresql://postgres@postgres:5432/trajetto?schema=public",
      );
      expect(seen).toContain("ALLOW_EMPTY_DATABASE_BOOTSTRAP=true");
      expect(seen).toContain(`JWT_SECRET=${TOKEN}`);
      // Never on a command line, and gone with the step.
      expect(result.docker.join("\n")).not.toContain(TOKEN);
      expect(existsSync(envFile)).toBe(false);
    });

    it("fails before any database when the API image carries the CLI, migrations or seeds", () => {
      const result = smoke({ content: 1 });

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        "a imagem da API traz o CLI do Prisma, migrations ou seeds",
      );
      expect(
        result.docker.filter((call) =>
          call.startsWith("docker network create"),
        ),
      ).toEqual([]);
      expect(result.summary).toBe("");
    });

    it.each([
      ["serves instead (the wait times out)", { guard: "hang" }, "timeout"],
      ["exits 0", { guard: "0" }, "0"],
      [
        "fails for another reason",
        { guardLog: "Error: Cannot find module" },
        "1",
      ],
    ])(
      "fails when the API, on the empty database, %s",
      (_case, options, code) => {
        const result = smoke(options);

        expect(result.status).toBe(1);
        expect(result.output).toContain(
          `a API não recusou o banco sem as migrations dela (saída ${code})`,
        );
        expect(
          result.docker.filter((call) => call.includes("trajetto-api-migrate")),
        ).toEqual([]);
        // The API never started: nothing of it to remove.
        expect(result.docker.slice(-4)).toEqual(cleanup.slice(1));
        expect(result.summary).toBe("");
      },
    );

    it("fails before starting the server when the release step fails", () => {
      const result = smoke({ migrate: 1 });

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        "::error::Smoke test da imagem trajetto-api: a etapa de release (a imagem trajetto-api-migrate) falhou num banco vazio. Nada foi publicado no GHCR",
      );
      expect(result.output).toContain("migrate: 136 migrations, seeds ok");
      expect(
        result.docker.filter((call) => call.includes("--health-interval")),
      ).toEqual([]);
      expect(result.docker.slice(-4)).toEqual(cleanup.slice(1));
      expect(result.summary).toBe("");
    });

    it("fails, with the container's log, when it exits, turns unhealthy or never leaves starting", () => {
      for (const states of [
        ["running/starting", "exited/unhealthy"],
        ["running/starting", "running/unhealthy"],
        ["running/starting"],
      ]) {
        const result = smoke({ states });
        const state = states[states.length - 1];

        expect(result.status, state).toBe(1);
        expect(result.output).toContain(
          `o container não ficou saudável (${state})`,
        );
        expect(result.output).toContain("api: boot log line");
        expect(result.docker.slice(-5)).toEqual(cleanup);
        expect(result.summary).toBe("");
      }
    });

    it("fails when liveness reports another commit, or readiness is not 200", () => {
      const other = smoke({ commit: "0".repeat(40) });

      expect(other.status).toBe(1);
      expect(other.output).toContain("/health/liveness informou o commit");
      expect(other.docker.slice(-5)).toEqual(cleanup);

      const unready = smoke({ ready: 1 });

      expect(unready.status).toBe(1);
      expect(unready.output).toContain(
        "/health/readiness não respondeu 200 (banco)",
      );
      expect(unready.docker.slice(-5)).toEqual(cleanup);
    });
  },
);
