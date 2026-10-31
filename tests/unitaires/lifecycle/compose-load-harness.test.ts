import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

import { freshDatabaseRefusal } from "../../../infra/scripts/database-bootstrap-guard";
import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The load harness (tests/load) measures the topology production runs.
 *
 * It ran one `tsx` process in NODE_ENV=test with no proxy and no memory
 * ceiling, next to an nginx config no script started; two of its thresholds
 * judged a surface the mix never called and passed with zero samples; the
 * soak's `{phase:late}` thresholds passed empty unless a variable nobody
 * documented was set; and the cross-replica socket script imported its client
 * from a folder that no longer exists. Text-based where the files are config,
 * executed where they are code.
 */
const ROOT = process.cwd();
const LOAD = resolve(ROOT, "tests", "load");

const read = (...path: string[]) =>
  readFileSync(resolve(...path), "utf8").replace(/\r\n/g, "\n");

const harness = read(LOAD, "compose.load.yaml");

describe("the harness topology (LOAD-1)", () => {
  it("puts Traefik v3 in front, pinned by digest — no nginx left to mistake for the edge", () => {
    expect(harness).toMatch(/image: traefik:v3\.\d+\.\d+@sha256:[0-9a-f]{64}/);
    expect(existsSync(resolve(LOAD, "nginx"))).toBe(false);
  });

  it("runs the production image, in production mode, capped, with replicas", () => {
    expect(harness).toMatch(
      /build:\n\s+context: \.\.\/\.\.\n\s+dockerfile: Dockerfile/,
    );
    expect(harness).toMatch(/\n\s+NODE_ENV: production\n/);

    // The production limit is a field of the API Application in Dokploy
    // (docs/deploy.md); the harness carries its own, never none.
    expect(harness).toMatch(/memory: \$\{API_MEMORY_LIMIT:-\d+M\}/);
    expect(harness).toMatch(/replicas: \$\{LOAD_REPLICAS:-([2-9])\}/);
  });

  it("takes an unready replica out of rotation by its readiness endpoint", () => {
    expect(harness).toContain(
      "loadbalancer.healthcheck.path=/health/readiness",
    );
    expect(harness).toContain("loadbalancer.server.port=3333");
  });

  it("cuts a slow request where production's Traefik does", () => {
    const reference = read(ROOT, "infra", "traefik", "traefik.reference.yaml");
    const production = reference.match(/readTimeout: (\d+s)/)?.[1];

    expect(production).toBeTruthy();
    expect(harness).toContain(
      `--entrypoints.web.transport.respondingtimeouts.readtimeout=${production}`,
    );
  });

  it("keeps k6 inside the Docker network, pinned", () => {
    expect(harness).toMatch(
      /image: grafana\/k6:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/,
    );
    expect(harness).toContain("LOAD_BASE_URL: http://traefik\n");
  });
});

/** The surface tag each function of lib/api.js records. */
function surfaceTags(): Map<string, string> {
  const api = read(LOAD, "lib", "api.js");
  const body = api.slice(api.indexOf("const surfaces = {"));
  const tags = new Map<string, string>();

  for (const match of body.matchAll(
    /\n {2}(\w+)\([^)]*\) \{[\s\S]*?record\("([\w.]+)"/g,
  )) {
    tags.set(match[1], match[2]);
  }

  return tags;
}

/** The surfaces a scenario file actually runs: the mix and direct calls. */
function executed(scenario: string): Set<string> {
  const tags = surfaceTags();
  const source = read(LOAD, scenario);
  const called = [...source.matchAll(/surfaces\.(\w+)\(/g)].map(
    (match) => match[1],
  );

  if (source.includes("runOneOperation(")) {
    const mix = read(LOAD, "lib", "mix.js");

    called.push(
      ...[...mix.matchAll(/surfaces\.(\w+)\(/g)].map((match) => match[1]),
    );
  }

  return new Set(called.map((name) => tags.get(name) ?? `?${name}`));
}

const SCENARIOS = ["smoke.js", "load.js", "stress.js", "spike.js", "soak.js"];

describe("every threshold has something to judge (LOAD-2)", () => {
  it("knows the tag of every surface", () => {
    expect(surfaceTags().get("health")).toBe("system.health");
    expect(surfaceTags().size).toBeGreaterThan(10);
  });

  it.each(SCENARIOS)("%s thresholds only on surfaces it runs", (scenario) => {
    const source = read(LOAD, scenario);
    const judged = [
      ...source.matchAll(/"surface_\w+\{surface:([\w.]+)\}"/g),
    ].map((m) => m[1]);
    const runs = executed(scenario);

    expect(judged.filter((tag) => !runs.has(tag))).toEqual([]);
  });

  it.each(SCENARIOS)(
    "%s plans its length when it thresholds on the late phase",
    (scenario) => {
      const source = read(LOAD, scenario);

      if (!source.includes("{phase:late}")) return;

      expect(source).toMatch(/planRun\(parseDuration\(/);
    },
  );

  it("gives a health scenario the whole length of the ramp it watches", () => {
    for (const scenario of ["stress.js", "spike.js"]) {
      expect(read(LOAD, scenario), scenario).toMatch(
        /exec: "health"[\s\S]*?duration: `\$\{stagesDuration\(\w+\)\}ms`/,
      );
    }
  });
});

describe("the durations the scenarios derive (LOAD-2)", () => {
  const load = async () =>
    import(pathToFileURL(resolve(LOAD, "lib", "duration.js")).href) as Promise<{
      parseDuration(text: string): number;
      stagesDuration(stages: Array<{ duration: string }>): number;
    }>;

  it("reads k6's duration format", async () => {
    const { parseDuration } = await load();

    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("500ms")).toBe(500);
  });

  it("refuses what it cannot read instead of planning zero", async () => {
    const { parseDuration } = await load();

    for (const bad of ["", "30", "30 minutes", "1x"]) {
      expect(() => parseDuration(bad), bad).toThrow(/Duração inválida/);
    }
  });

  it("adds up a ramp", async () => {
    const { stagesDuration } = await load();

    expect(stagesDuration([{ duration: "45s" }, { duration: "1m" }])).toBe(
      105_000,
    );
  });
});

describe("the socket client the cross-replica script uses (LOAD-3)", () => {
  interface Resolver {
    socketClientEntry(options?: {
      env?: Record<string, string | undefined>;
      root?: string;
      exists?: (path: string) => boolean;
    }): string;
    loadSocketClient(): Promise<unknown>;
  }

  const load = async () =>
    import(
      pathToFileURL(resolve(LOAD, "lib", "socket-client.mjs")).href
    ) as Promise<Resolver>;

  const root = resolve("/repos/trajetto-api");
  const entry = (repository: string) =>
    pathToFileURL(
      resolve(
        root,
        "..",
        repository,
        "node_modules",
        "socket.io-client",
        "build",
        "esm",
        "index.js",
      ),
    ).href;

  it("is what the script imports", () => {
    const script = read(LOAD, "socket-across-replicas.mjs");

    expect(script).toContain('from "./lib/socket-client.mjs"');
    expect(script).not.toContain("trajetto-fleet-manager-ui/node_modules");
  });

  const own = pathToFileURL(
    resolve(
      root,
      "node_modules",
      "socket.io-client",
      "build",
      "esm",
      "index.js",
    ),
  ).href;

  it("takes the API's own devDependency first, so CI needs no web checkout", async () => {
    const { socketClientEntry } = await load();

    expect(socketClientEntry({ env: {}, root, exists: () => true })).toBe(own);
  });

  it("finds the web by its current folder name first, the old one second", async () => {
    const { socketClientEntry } = await load();

    expect(
      socketClientEntry({
        env: {},
        root,
        exists: (path) => path.includes("trajetto-ui"),
      }),
    ).toBe(entry("trajetto-ui"));
    expect(
      socketClientEntry({
        env: {},
        root,
        exists: (path) => path.includes("fleet-manager"),
      }),
    ).toBe(entry("trajetto-fleet-manager-ui"));
  });

  it("takes SOCKET_IO_CLIENT_ENTRY over both", async () => {
    const { socketClientEntry } = await load();
    const override = resolve("/elsewhere/index.js");

    expect(
      socketClientEntry({
        env: { SOCKET_IO_CLIENT_ENTRY: override },
        root,
        exists: () => true,
      }),
    ).toBe(pathToFileURL(override).href);
  });

  it("says what to install when none is there", async () => {
    const { socketClientEntry } = await load();

    expect(() =>
      socketClientEntry({ env: {}, root, exists: () => false }),
    ).toThrow(
      /yarn install.*nesta API.*instale as dependências de \.\.\/trajetto-ui/,
    );
  });

  it("is a devDependency of the API, never a production one", () => {
    const manifest = JSON.parse(read(ROOT, "package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.devDependencies?.["socket.io-client"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(manifest.dependencies?.["socket.io-client"]).toBeUndefined();
  });

  it("loads the real client from the API's own node_modules", async () => {
    const { loadSocketClient } = await load();

    expect(typeof (await loadSocketClient())).toBe("function");
  });
});

describe("the harness files", () => {
  it("has no script left pointing at the old web folder", () => {
    const offenders = readdirSync(LOAD, { recursive: true })
      .map(String)
      .filter((file) => /\.(m?js|sh|ts)$/.test(file))
      .filter((file) =>
        read(LOAD, file).includes("trajetto-fleet-manager-ui/node_modules"),
      );

    expect(offenders).toEqual([]);
  });
});

/**
 * The replicas boot on a fresh, EMPTY load_test.
 *
 * The API image never migrates: it runs NODE_ENV=production, production's
 * bootstrap guard refuses an empty database (process.exit(1)) and the schema
 * guard refuses one without the build's migrations. The documented order
 * started them first and migrated afterwards: both replicas stayed Exited,
 * Traefik had no backend and every scene hit 404/502. Now a one-off
 * `migrate` service — the release image, trajetto-api-migrate — prepares the
 * database, and the replicas wait for it to exit 0.
 *
 * Rendered by the real `docker compose config`, so anchors, merges and
 * interpolation are what compose itself makes of the file.
 */
const hasCompose =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status ===
  0;

type Service = {
  image?: string;
  build?: { target?: string };
  command?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
};

let rendered: Record<string, Service> | undefined;

function renderHarness(): Record<string, Service> {
  if (rendered) return rendered;

  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      resolve(LOAD, "compose.load.yaml"),
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        JWT_SECRET: "load-jwt",
        JWT_SECRET_REFRESH_TOKEN: "load-refresh",
      },
    },
  );

  if (result.status !== 0)
    throw new Error(`docker compose config: ${result.stderr}`);

  rendered = JSON.parse(result.stdout).services as Record<string, Service>;

  return rendered;
}

describe("the release step runs before the replicas (LOAD-1)", () => {
  it("waits for the release step in the file itself", () => {
    // Text too, so a machine without docker still guards the order.
    expect(harness).toMatch(
      /\n {6}migrate:\n {8}condition: service_completed_successfully\n/,
    );
  });

  describe.skipIf(!hasCompose)("as docker compose renders it", () => {
    // Every container of either image: the API's, and the release image
    // built on top of it.
    const booting = () => {
      const services = renderHarness();
      const images = [services.api?.image, services.migrate?.image];

      return Object.entries(services).filter(([, service]) =>
        images.includes(service.image),
      );
    };

    it("prepares the empty database with the release image, bootstrap allowed only there", () => {
      const services = renderHarness();
      const migrate = services.migrate;

      expect(migrate?.command).toEqual(["./docker-entrypoint.sh", "migrate"]);
      // The API image carries no Prisma CLI: the release step is the image
      // built from the Dockerfile's `migrate` stage, the replicas the
      // `runner` one.
      expect(migrate?.image).toBe("trajetto-api-migrate:load");
      expect(migrate?.build?.target).toBe("migrate");
      expect(services.api?.build?.target).toBe("runner");

      // The same database and secrets as the replicas, plus the one flag.
      const { ALLOW_EMPTY_DATABASE_BOOTSTRAP, ...rest } =
        migrate?.environment ?? {};

      expect(ALLOW_EMPTY_DATABASE_BOOTSTRAP).toBe("true");
      expect(rest).toEqual(services.api.environment);
      expect(services.api.environment).not.toHaveProperty(
        "ALLOW_EMPTY_DATABASE_BOOTSTRAP",
      );
    });

    it("boots nothing on the empty database that the guard would refuse", () => {
      // Each service running the API image, as the guard sees the database
      // when it starts: empty, unless it waits for a completed release step.
      const services = renderHarness();
      const refused = booting()
        .filter(([, service]) => {
          const waitsForRelease = Object.entries(service.depends_on ?? {}).some(
            ([name, dependency]) =>
              dependency.condition === "service_completed_successfully" &&
              services[name]?.command?.includes("migrate"),
          );

          return (
            freshDatabaseRefusal({
              nodeEnv: service.environment?.NODE_ENV,
              appliedMigrations: waitsForRelease ? 1 : 0,
              allowBootstrap:
                service.environment?.ALLOW_EMPTY_DATABASE_BOOTSTRAP === "true",
            }) !== null
          );
        })
        .map(([name]) => name);

      expect(
        booting()
          .map(([name]) => name)
          .sort(),
      ).toEqual(["api", "migrate"]);
      expect(refused).toEqual([]);
    });

    it("gives every API container an environment the production schema accepts", () => {
      for (const [name, service] of booting()) {
        const parsed = envSchema.safeParse(
          definedEnv(service.environment ?? {}),
        );

        expect(
          parsed.success,
          `${name}: ${JSON.stringify(parsed.error?.format())}`,
        ).toBe(true);
        expect(service.environment?.NODE_ENV, name).toBe("production");
      }
    });
  });
});

/**
 * multi-replica.sh against the harness.
 *
 * Its compose calls carried no --env-file, and the compose file requires
 * JWT_SECRET: every call failed before doing anything. Step 0 hid that
 * (stderr to /dev/null) and read the empty log as "one replica served
 * everything"; step 2 and the final `docker stats` failed quietly. Run for
 * real here, with docker and curl stubbed: the docker stub refuses a compose
 * call without --env-file exactly as compose does.
 */
const bash = hasShell("bash");

const DOCKER = `
case " $* " in
  *" compose "*)
    case " $* " in
      *" --env-file "*) ;;
      *) echo "required variable JWT_SECRET is missing a value: Defina JWT_SECRET" >&2; exit 1 ;;
    esac ;;
esac
case " $* " in
  *" logs "*)
    if [ -n "\${STUB_LOGS_ERROR:-}" ]; then echo "$STUB_LOGS_ERROR" >&2; exit 1; fi
    cat "$STUB_TRAEFIK_LOG" ;;
  *" exec "*) echo "\${STUB_STUCK:-0}" ;;
  *" ps -q "*) echo c0ffee ;;
  *" stats "*) echo "  trajetto-load-api-1: CPU 1%" ;;
esac
exit 0`;

const CURL = `
case "$*" in
  *http_code*) printf 200 ;;
esac
exit 0`;

describe.skipIf(!bash)("multi-replica.sh (LOAD-1, LOAD-3)", () => {
  let box: Sandbox;
  let envFile: string;

  const accessLog = (...replicas: string[]) =>
    replicas
      .flatMap((url) =>
        Array.from({ length: 20 }, () => JSON.stringify({ ServiceURL: url })),
      )
      .join("\n");

  beforeEach(() => {
    box = sandbox();
    box.stub("docker", DOCKER);
    box.stub("curl", CURL);
    envFile = box.file(
      "harness.env",
      "JWT_SECRET=x\nJWT_SECRET_REFRESH_TOKEN=y\n",
    );
  });

  afterEach(() => box.dispose());

  function multiReplica(env: Record<string, string>) {
    return run("bash", repoFile("tests/load/multi-replica.sh"), [], {
      bin: box.bin,
      env: {
        LOAD_ENV_FILE: envFile,
        STUB_TRAEFIK_LOG: box.file(
          "traefik.log",
          accessLog("http://172.20.0.3:3333", "http://172.20.0.4:3333"),
        ),
        ...env,
      },
    });
  }

  it("passes the harness' env file to every compose call", () => {
    const result = multiReplica({ LOAD_STEPS: "0 2" });
    const compose = box
      .calls("docker")
      .filter((call) => call.startsWith("docker compose"));

    expect(result.status, result.stdout + result.stderr).toBe(0);
    // logs (step 0), two psql (step 2), ps (the closing docker stats).
    expect(compose).toHaveLength(4);

    for (const call of compose) expect(call).toContain(`--env-file ${envFile}`);

    expect(result.stdout).toContain("http://172.20.0.3:3333: 20");
    expect(result.stdout).toContain("http://172.20.0.4:3333: 20");
    expect(result.stdout).not.toContain("FALHOU");
  });

  it("reports a compose failure as one, not as a one-replica split", () => {
    const result = multiReplica({
      LOAD_STEPS: "0",
      STUB_LOGS_ERROR: "no such service: traefik",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("no such service: traefik");
    expect(result.stdout).not.toContain("uma réplica só atendeu");
  });

  it("still fails a real one-replica split", () => {
    const result = multiReplica({
      LOAD_STEPS: "0",
      STUB_TRAEFIK_LOG: box.file(
        "one.log",
        accessLog("http://172.20.0.3:3333"),
      ),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("uma réplica só atendeu");
  });

  it("fails on a stuck queue row", () => {
    const result = multiReplica({ LOAD_STEPS: "2", STUB_STUCK: "3" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/webhook_delivery tem 3 linha/);
  });

  it("stops before touching docker when the env file is not there", () => {
    const result = multiReplica({ LOAD_ENV_FILE: `${box.root}/missing.env` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LOAD_ENV_FILE");
    expect(box.calls("docker")).toEqual([]);
  });
});
