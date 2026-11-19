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

  // plano-escala F1-04: a run measured against the stock postgres:16-alpine
  // (shared_buffers 128MB, jit on, parallel workers) measured a database
  // production does not run. The harness builds the very image of the
  // servers, and caps it the way the Database is capped.
  it("runs production's Postgres image, with all its memory derived from the cap it is given", () => {
    const postgres = harness.slice(
      harness.indexOf("\n  postgres:\n"),
      harness.indexOf("\n  redis:\n"),
    );

    expect(postgres).toMatch(
      /\n {4}build:\n {6}context: \.\.\/\.\.\/infra\/postgres\n/,
    );
    expect(postgres).not.toMatch(/\n {4}image:/);
    // The same variable sets the container's limit and the wrapper's sum.
    expect(postgres).toContain(
      "POSTGRES_MEMORY_LIMIT_MB: ${LOAD_PG_MEMORY_MB:-2048}",
    );
    expect(postgres).toMatch(
      /\n {4}deploy:\n {6}resources:\n {8}limits:\n {10}memory: \$\{LOAD_PG_MEMORY_MB:-2048\}M\n/,
    );
    // Only an extra flag, last, as the Database's Args: the preload and the
    // static parameters (jit off among them) come from the image.
    expect(postgres).toContain(
      'command: ["postgres", "-c", "pg_stat_statements.track=all"]',
    );
    expect(postgres).not.toContain("shared_preload_libraries");
    expect(postgres).not.toMatch(/PITR_ARCHIVE|PGBACKREST_/);
    expect(read(ROOT, "infra", "postgres", "postgres.params")).toMatch(
      /^jit=off$/m,
    );
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

const SCENARIOS = [
  "smoke.js",
  "load.js",
  "stress.js",
  "spike.js",
  "soak.js",
  // plano-escala LOAD-03.
  "write-mix.js",
  "positions.js",
  "tower.js",
  "noisy-tenant.js",
  "outage.js",
  // plano-escala LOAD-04.
  "import-20k.js",
  "import-geocode.js",
  // plano-escala LOAD-11.
  "positions-5m.js",
];

/** The k6 scenes judged elsewhere: rolling.js by swarm-rolling-script. */
const OTHER_SCENES = ["rolling.js"];

/** The k6 scenes of plano-escala LOAD-04 (the import's two). */
const LOAD_04_SCENES = ["import-20k.js", "import-geocode.js"];

/** The k6 scene of plano-escala LOAD-11 (the 5M gate's positions). */
const LOAD_11_SCENES = ["positions-5m.js"];

/** The scenes plano-escala LOAD-03 added, with what their verdict reads. */
const LOAD_03_SCENES = [
  "write-mix.js",
  "positions.js",
  "tower.js",
  "noisy-tenant.js",
  "outage.js",
];

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

  it.each(["socket-across-replicas.mjs", "socket-fleet.mjs"])(
    "is what %s imports",
    (name) => {
      const script = read(LOAD, name);

      expect(script).toContain('from "./lib/socket-client.mjs"');
      expect(script).not.toContain("trajetto-fleet-manager-ui/node_modules");
    },
  );

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

/**
 * The scenes of the scale plan (LOAD-03). A scene nobody lists is a scene
 * nobody runs: every k6 file of tests/load is here or judged elsewhere, and
 * in the README's table. Each one prints p99 too and names in its
 * thresholds the tagged numbers its acceptance compares, so the
 * summary-export (`--summary-export`) carries them to lib/verdicts.mjs.
 */
describe("the scenes (LOAD-03)", () => {
  const readme = read(LOAD, "README.md");

  it("lists every k6 scene of the harness", () => {
    const scenes = readdirSync(LOAD).filter((file) => file.endsWith(".js"));

    expect(
      scenes.filter(
        (scene) => !SCENARIOS.includes(scene) && !OTHER_SCENES.includes(scene),
      ),
    ).toEqual([]);
  });

  it.each(SCENARIOS)("%s is in the README's table of scenes", (scene) => {
    expect(readme).toMatch(
      new RegExp(`\\| \`${scene.replace(".", "\\.")}\` +\\|`),
    );
  });

  it.each([...LOAD_03_SCENES, ...LOAD_04_SCENES, ...LOAD_11_SCENES])(
    "%s summarises p99 and is run with its summary-export",
    (scene) => {
      expect(read(LOAD, scene)).toContain(
        "summaryTrendStats: SUMMARY_TREND_STATS",
      );
      expect(readme).toContain(
        `--summary-export /results/${scene.replace(".js", "")}.json`,
      );
    },
  );

  it("tags what the noisy-tenant and outage verdicts compare", () => {
    const noisy = read(LOAD, "noisy-tenant.js");
    const outage = read(LOAD, "outage.js");

    expect(noisy).toMatch(
      /breakdownOf\("class", \["normal", "noisy"\], "stage", \[\s*"baseline",\s*"noisy",?\s*\]\)/,
    );
    expect(outage).toContain("outage_attempts{stage:${stage}}");
  });

  it("gives the spike its acceptance behind SPIKE_ACCEPTANCE", () => {
    const spike = read(LOAD, "spike.js");

    expect(spike).toContain('__ENV.SPIKE_ACCEPTANCE === "true"');
    expect(spike).toContain('surface_failures: ["rate==0"]');
    expect(spike).toContain('surface_latency: ["p(95)<1000", "max<10000"]');
    expect(spike).toContain(
      '"surface_latency{window:recovery}": ["p(95)<1000"]',
    );
  });

  it("weighs the positions in the mix by the corrected ruler (~1 request in 9)", () => {
    const mix = read(LOAD, "lib", "mix.js");
    const weights = [
      ...mix.matchAll(/weight: (\d+), run: \(([^)]*)\) => surfaces\.(\w+)\(/g),
    ];
    const total = weights.reduce((sum, match) => sum + Number(match[1]), 0);
    const positions = weights.find((match) => match[3] === "recordPositions");

    // ~333 POST/s of ~3,000 requests a second at the 5M step: 11%.
    const share = Number(positions?.[1]) / total;

    expect(share).toBeGreaterThan(0.09);
    expect(share).toBeLessThan(0.15);
  });

  it("never counts a refusal with Retry-After as a failure", () => {
    const api = read(LOAD, "lib", "api.js");

    expect(api).toMatch(
      /const refused =\s*\(response\.status === 429 \|\| response\.status === 503\) &&\s*retryAfterOf\(response\) !== null;/,
    );
    expect(api).toContain("expected.includes(r.status) || refused");
  });
});

/**
 * The socket fleet (plano-escala LOAD-05) on the harness: eight containers
 * on the harness' edge network, one IP each, one shard each, started
 * together and merged. A README that ran them on the host (one address
 * behind the published port) or with another Node image than the burn-in's
 * would measure the limiter or run code nobody pinned.
 */
describe("the socket fleet on the harness (LOAD-05)", () => {
  const readme = read(LOAD, "README.md");
  const section = readme.slice(readme.indexOf("## Frota de sockets"));

  it("runs eight shards, one container each, on the harness network, and merges them", () => {
    expect(section).toContain("--network trajetto-load-edge");
    expect(section).toContain("FLEET_SHARD=$i/8");
    expect(section).toContain("FLEET_START_AT=$START");
    expect(section).toContain("FLEET_URL=http://traefik");
    expect(section).toContain("node tests/load/socket-fleet.mjs merge");
    expect(harness).toContain("name: trajetto-load-edge");
  });

  it("pins the burn-in's Node image", () => {
    const burnIn = read(LOAD, "staging-burn-in.sh");
    const pinned = burnIn.match(
      /NODE_IMAGE="(node:[^"]+@sha256:[0-9a-f]{64})"/,
    );

    expect(pinned?.[1]).toBeTruthy();
    expect(section).toContain(`NODE_IMAGE=${pinned?.[1]}`);
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
 * plano-escala LOAD-01: the harness with the roles of the same image, the
 * images swappable and the CPU pinned like the single VPS.
 *
 * The scale plan splits the API's image into roles (F3-01): the api only
 * takes requests, a worker claims the queues and runs the cron. A bench
 * that only ever ran `all` measured a fleet production stops running in
 * phase C, and a bench with all the machine's cores measured a server
 * production does not have. Without a profile the harness stays exactly
 * what it was; `--profile roles` with LOAD_API_ROLE=api is api ×2 without
 * workers plus worker ×1.
 */
type RoleService = Service & {
  deploy?: { replicas?: number; resources?: { limits?: { cpus?: number } } };
  cpuset?: string;
  labels?: Record<string, string> | string[];
  networks?: Record<string, unknown>;
  profiles?: string[];
};

function renderWith(
  args: string[],
  env: Record<string, string> = {},
): Record<string, RoleService> {
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...args,
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
        ...env,
      },
    },
  );

  if (result.status !== 0)
    throw new Error(`docker compose config: ${result.stderr}`);

  return JSON.parse(result.stdout).services as Record<string, RoleService>;
}

describe("the roles of the harness (LOAD-01)", () => {
  /** The services of the file, by their two-space indentation. */
  const block = (name: string) => {
    const start = harness.indexOf(`\n  ${name}:\n`);
    const end = harness.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);

    return harness.slice(start, end === -1 ? undefined : start + 1 + end);
  };

  it("adds the worker, the realtime and the ingest only under their profiles", () => {
    expect(block("worker")).toContain('profiles: ["roles"]');
    expect(block("realtime")).toContain('profiles: ["realtime"]');
    expect(block("ingest")).toContain('profiles: ["ingest"]');
    expect(block("api")).not.toContain("profiles:");
    expect(block("worker")).toContain("PROCESS_ROLE: worker");
    expect(block("realtime")).toContain("PROCESS_ROLE: realtime");
    expect(block("ingest")).toContain("PROCESS_ROLE: ingest");
  });

  it("gives the replicas the role `all` unless LOAD_API_ROLE says otherwise", () => {
    expect(harness).toContain("PROCESS_ROLE: ${LOAD_API_ROLE:-all}");
    // The old switch, now the role's preset: an explicit true would keep
    // the api's workers on whatever LOAD_API_ROLE says.
    expect(harness).not.toMatch(/^\s+WORKERS_ENABLED:/m);
  });

  it("lets every role run another image, the API's by default", () => {
    expect(block("worker")).toContain(
      "image: ${LOAD_WORKER_IMAGE:-${LOAD_API_IMAGE:-trajetto-api:load}}",
    );
    expect(block("realtime")).toContain(
      "image: ${LOAD_REALTIME_IMAGE:-${LOAD_API_IMAGE:-trajetto-api:load}}",
    );
  });

  it("pins every service's CPU by a variable, and the env file covers them all", () => {
    const variables = [
      ...harness.matchAll(/cpuset: \$\{(LOAD_\w+_CPUSET):-\}/g),
    ]
      .map((match) => match[1])
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    const env = read(LOAD, "vps-6vcpu.env");
    const values = Object.fromEntries(
      [...env.matchAll(/^(LOAD_\w+_CPUSET)=(\S+)$/gm)].map((match) => [
        match[1],
        match[2],
      ]),
    );

    expect(variables).toEqual(
      [
        "LOAD_API_CPUSET",
        "LOAD_K6_CPUSET",
        "LOAD_PG_CPUSET",
        "LOAD_REALTIME_CPUSET",
        "LOAD_INGEST_CPUSET",
        "LOAD_REDIS_CPUSET",
        "LOAD_TRAEFIK_CPUSET",
        "LOAD_WORKER_CPUSET",
      ].sort(),
    );
    expect(Object.keys(values).sort()).toEqual(variables);

    // The stack on the VPS's six cores, k6 on others.
    const cores = (set: string) => {
      const [from, to] = set.split("-").map(Number);

      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    };
    const stack = new Set(
      Object.entries(values)
        .filter(([name]) => name !== "LOAD_K6_CPUSET")
        .flatMap(([, set]) => cores(set)),
    );

    expect([...stack].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cores(values.LOAD_K6_CPUSET).some((core) => stack.has(core))).toBe(
      false,
    );
  });

  describe.skipIf(!hasCompose)("as docker compose renders it", () => {
    it("is today's harness without a profile", () => {
      const services = renderWith([]);

      expect(Object.keys(services).sort()).toEqual(
        ["api", "migrate", "postgres", "redis", "traefik"].sort(),
      );
      expect(services.api.environment?.PROCESS_ROLE).toBe("all");
      expect(services.api.deploy?.replicas).toBe(2);
      expect(services.api.cpuset).toBeUndefined();
    });

    it("runs api ×2 without workers and worker ×1 with --profile roles", () => {
      const services = renderWith(["--profile", "roles"], {
        LOAD_API_ROLE: "api",
      });
      const role = (name: string) => {
        const parsed = envSchema.safeParse(
          definedEnv(services[name].environment ?? {}),
        );

        expect(
          parsed.success,
          `${name}: ${JSON.stringify(parsed.error?.format())}`,
        ).toBe(true);

        return parsed.data!;
      };

      expect(services.api.deploy?.replicas).toBe(2);
      expect(services.worker.deploy?.replicas).toBe(1);

      const api = role("api");
      const worker = role("worker");

      expect(api.PROCESS_ROLE).toBe("api");
      expect(api.WORKERS_ENABLED).toBe(false);
      expect(api.WORKER_QUEUES).toEqual([]);
      expect(api.CRON_ENABLED).toBe(false);

      expect(worker.PROCESS_ROLE).toBe("worker");
      expect(worker.WORKERS_ENABLED).toBe(true);
      expect(worker.CRON_ENABLED).toBe(true);
      expect(worker.WORKER_QUEUES).toEqual([
        "outbox",
        "internal",
        "external",
        "webhooks",
        "ai",
        "jobs",
      ]);
      expect(worker.SOCKETS_ENABLED).toBe(false);

      // The worker is off the edge: Traefik never routes to it.
      expect(Object.keys(services.worker.networks ?? {})).toEqual(["data"]);
      expect(services.worker.depends_on?.migrate?.condition).toBe(
        "service_completed_successfully",
      );
    });

    it("puts the realtime behind Traefik on /socket.io with --profile realtime", () => {
      const services = renderWith(["--profile", "realtime"], {
        LOAD_API_SOCKETS: "false",
      });
      const labels = JSON.stringify(services.realtime.labels);
      const realtime = envSchema.safeParse(
        definedEnv(services.realtime.environment ?? {}),
      );
      const api = envSchema.safeParse(
        definedEnv(services.api.environment ?? {}),
      );

      expect(labels).toContain("PathPrefix(`/socket.io`)");
      expect(labels).toContain(
        '"traefik.http.services.load-realtime.loadbalancer.healthcheck.path":"/health/readiness"',
      );
      expect(realtime.success && realtime.data.PROCESS_ROLE).toBe("realtime");
      expect(realtime.success && realtime.data.SOCKETS_ENABLED).toBe(true);
      expect(api.success && api.data.SOCKETS_ENABLED).toBe(false);
    });

    it("pins the stack to cores 0-5 and k6 outside them with vps-6vcpu.env", () => {
      const services = renderWith([
        "--env-file",
        resolve(LOAD, "vps-6vcpu.env"),
        "--profile",
        "roles",
        "--profile",
        "k6",
      ]);

      for (const name of [
        "traefik",
        "migrate",
        "api",
        "worker",
        "postgres",
        "redis",
      ]) {
        expect(services[name].cpuset, name).toBe("0-5");
      }

      expect(services.k6.cpuset).toBe("6-9");
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
  *" exec "*)
    # The roles' steps (LOAD-07) ask their own questions; anything else is
    # step 2's count of stuck rows.
    case "$*" in
      *PSUBSCRIBE*)
        printf 'psubscribe\\n*:wake:outbox\\n1\\n'
        i=0
        while [ "$i" -lt "\${STUB_HINTS:-1}" ]; do
          printf 'pmessage\\n*:wake:outbox\\nk:wake:outbox\\n{}\\n'
          i=$((i + 1))
        done ;;
      *pkill*) ;;
      *"status = 'PROCESSING'"*) echo "\${STUB_STUCK:-0}" ;;
      *array_to_string*) printf 'api filas= cron=false\\nworker filas=outbox cron=true\\n' ;;
      *"cardinality(queues) > 0"*) echo "\${STUB_CLAIMERS-worker}" ;;
      *"role = 'api'"*) echo 2 ;;
      *worker_heartbeat*) echo "\${STUB_STRAYS:-0}" ;;
      *"AT TIME ZONE"*) echo "2026-11-18 12:00:00" ;;
      *chat-message.sent*) echo "\${STUB_TAKEN-150}" ;;
      *"role = 'cluster'"*) echo "\${STUB_EFFECTS-10:01=1 10:02=1 10:03=1}" ;;
      *generate_series*) echo "\${STUB_RUNS-10:01=1 10:02=1 10:03=1}" ;;
      *"AND cron"*) echo "\${STUB_CRON-worker}" ;;
      *) echo "\${STUB_STUCK:-0}" ;;
    esac ;;
  *" ps --services "*) printf '%s\\n' \${STUB_SERVICES:-} ;;
  *" ps -q "*) echo c0ffee ;;
  *" stats "*) echo "  trajetto-load-api-1: CPU 1%" ;;
esac
exit 0`;

const CURL = `
case "$*" in
  *send-message*) printf "\${STUB_SEND_CODE:-201}" ;;
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

  /**
   * plano-escala LOAD-07: the split fleet's questions. Only the worker
   * claims (the api replicas declare no queue, no queue loop beats outside
   * the worker); a notification created on the api reaches the worker in
   * under 2 s through the wake hint, and the run fails without the hint
   * even when the time alone would pass; and each cron runs once per
   * scheduled minute, only on the worker.
   */
  describe("with the roles of the same image (LOAD-07)", () => {
    beforeEach(() => {
      box.stub("sleep", "exit 0");
    });

    it("joins steps 6 to 8 by itself only when the harness runs the worker", () => {
      // Every step runs here: node answers nothing, so the socket and the
      // rate-limit steps fail at once instead of reaching for a replica.
      box.stub("node", "exit 0");

      const split = multiReplica({
        STUB_SERVICES: "traefik api worker postgres redis",
        LOAD_STEPS: "",
        LOAD_PORTS: "1 2",
      });
      const single = multiReplica({
        STUB_SERVICES: "traefik api postgres redis",
        LOAD_STEPS: "",
        LOAD_PORTS: "1 2",
      });

      expect(split.stdout).toContain("== 6. Só o worker reivindica? ==");
      expect(split.stdout).toContain("== 8. Cada cron roda");
      expect(single.stdout).not.toContain("== 6.");
      expect(single.stdout).toContain("== 5. A vazão sobe? ==");
    });

    it("passes when only the worker claims, the hint wakes it and the cron runs once", () => {
      const result = multiReplica({ LOAD_STEPS: "6 7 8" });

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("envio 1: 150 ms até o worker");
      expect(result.stdout).toContain("dicas de despertar no canal: 1");
      expect(result.stdout).toContain("com o cron: worker");
      expect(result.stdout).not.toContain("FALHOU");

      // The chat goes through an api replica's own port, and the hint is
      // read from Redis itself.
      expect(box.calls("curl").join("\n")).toContain(
        "http://localhost:3341/chat/send-message",
      );
      expect(box.calls("docker").join("\n")).toContain(
        "redis timeout 40 redis-cli PSUBSCRIBE *:wake:outbox",
      );
    });

    it("fails when the api replicas claim too (LOAD_API_ROLE forgotten)", () => {
      const result = multiReplica({
        LOAD_STEPS: "6",
        STUB_CLAIMERS: "all,worker",
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "quem consome filas: 'all,worker', não só o worker (suba com LOAD_API_ROLE=api",
      );
    });

    it("fails on a queue loop beating outside the worker", () => {
      const result = multiReplica({ LOAD_STEPS: "6", STUB_STRAYS: "2" });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "2 laço(s) de fila batendo fora do worker",
      );
    });

    it("fails without the wake hint, even when the sweep was quick enough", () => {
      const result = multiReplica({ LOAD_STEPS: "7", STUB_HINTS: "0" });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("envio 3: 150 ms até o worker");
      expect(result.stdout).toContain(
        "nenhuma dica de despertar no canal *:wake:outbox",
      );
    });

    it("fails when the notification takes 2 s or more", () => {
      const result = multiReplica({ LOAD_STEPS: "7", STUB_TAKEN: "2400" });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "o evento do envio 1 levou 2400 ms até o worker, não < 2000",
      );
    });

    it("fails when the api refuses the message", () => {
      const result = multiReplica({ LOAD_STEPS: "7", STUB_SEND_CODE: "401" });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("respondeu 401, não 201");
    });

    it.each([
      [
        "a minute without the heartbeat",
        { STUB_RUNS: "10:01=1 10:02=0 10:03=1" },
        "não rodou exatamente uma vez",
      ],
      [
        "a cron on the api too",
        { STUB_CRON: "api,worker" },
        "quem roda o cron: 'api,worker'",
      ],
      [
        "a minute the heartbeat ran twice",
        { STUB_EFFECTS: "10:01=1 10:02=2 10:03=1" },
        "o ops-heartbeat rodou mais de uma vez no mesmo minuto",
      ],
      [
        "a minute whose run left no row of its own",
        { STUB_EFFECTS: "10:01=1 10:02=0 10:03=1" },
        "OPS_SAMPLE_ENABLED=false",
      ],
      [
        "no complete minute yet",
        { STUB_RUNS: "" },
        "rode este passo de novo daqui a 2 minutos",
      ],
    ])("fails step 8 on %s", (_case, env, says) => {
      const result = multiReplica({ LOAD_STEPS: "8", ...env });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(says);
    });

    // Review of wave 12: the check of a firing run twice grouped
    // scheduled_job_execution by (jobName, scheduledFor), the table's own
    // unique, so it could never find one. It counts the run's own row now,
    // in a table with nothing keeping it to one a minute.
    it("counts the runs of a minute where a second one would show", () => {
      const script = readFileSync(
        repoFile("tests/load/multi-replica.sh"),
        "utf8",
      );
      const schema = readFileSync(repoFile("prisma/schema.prisma"), "utf8");
      const model = (name: string) =>
        /model (\w+) \{[\s\S]*?\n\}/g.exec(
          schema.slice(schema.indexOf(`model ${name} {`)),
        )?.[0] ?? "";

      expect(model("ScheduledJobExecution")).toContain(
        "@@unique([jobName, scheduledFor])",
      );
      expect(model("OpsSample")).toContain("ts DateTime");
      expect(model("OpsSample")).not.toMatch(/@@(unique|id)\(/);

      const step = script.slice(
        script.indexOf("if asked 8; then"),
        script.indexOf('say "== CPU e memória agora =="'),
      );

      expect(step).toContain(
        "FROM ops_sample o WHERE o.role = 'cluster' AND o.ts = m.slot",
      );
      expect(step).not.toMatch(/GROUP BY \\"jobName\\", \\"scheduledFor\\"/);
    });
  });

  it("stops before touching docker when the env file is not there", () => {
    const result = multiReplica({ LOAD_ENV_FILE: `${box.root}/missing.env` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LOAD_ENV_FILE");
    expect(box.calls("docker")).toEqual([]);
  });
});

/**
 * The queue and import scenes (plano-escala LOAD-04): the drain of 50 000
 * events and 20 000 notifications, one company's flood of 20 000 external
 * messages, a spreadsheet of 20 000 lines and the geocoding of 20 000
 * addresses at the Startup plan's rates.
 *
 * What each must not do is reach anything real: the two that write the
 * queues by SQL refuse every database but the disposable one before they
 * connect; the import's spreadsheet is the one the importer reads without a
 * single rejected row (a broken file would measure a list of errors); the
 * fake geocoder answers what the API parses and refuses what LocationIQ
 * would; and the harness calls it only when the scene's env file is named.
 */
describe("the queue and import scenes (LOAD-04)", () => {
  const readme = read(LOAD, "README.md");
  const section = readme.slice(
    readme.indexOf("### As cenas de fila e importação (LOAD-04)"),
  );
  const tsxCli = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

  it.each([
    "drain-backlog.mjs",
    "queue-flood.ts",
    "import-20k.js",
    "import-geocode.js",
  ])("%s is in the README's table of the queue scenes", (scene) => {
    expect(section).toMatch(
      new RegExp(`\\| \`${scene.replace(".", "\\.")}\` +\\|`),
    );
  });

  it.each(["drain-backlog.mjs", "queue-flood.ts"])(
    "%s refuses a database that is not the disposable one, before connecting",
    (scene) => {
      const source = read(LOAD, scene);

      expect(
        source.indexOf("assertDisposableDatabase(env.DATABASE_URL"),
      ).toBeLessThan(source.indexOf("new pg.Client"));

      const result = spawnSync(
        process.execPath,
        [tsxCli, resolve(LOAD, scene)],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            DATABASE_URL:
              "postgresql://load:load@db.example.com:5432/load_test",
            LOAD_PG_PORT: "",
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Só no banco descartável",
      );
    },
    60_000,
  );

  describe("the spreadsheet the import scenes upload", () => {
    const load = async () =>
      import(
        pathToFileURL(resolve(LOAD, "lib", "spreadsheet.js")).href
      ) as Promise<{
        MAX_LINES: number;
        spreadsheetRows(
          rows: number,
          marker: string,
          options: { coordinates: boolean },
        ): { filename: string; text: string };
      }>;

    const parse = async (sheet: { filename: string; text: string }) => {
      const { readSpreadsheet } =
        await import("@/shared/delivery/spreadsheet-reader");
      const { parseDeliverySpreadsheet } =
        await import("@/shared/delivery/spreadsheet-parser");

      return parseDeliverySpreadsheet(
        await readSpreadsheet(
          sheet.filename,
          Buffer.from(sheet.text, "utf8").toString("base64"),
        ),
      );
    };

    it("is read by the importer at its ceiling, every row a delivery with its point", async () => {
      const { MAX_LINES, spreadsheetRows } = await load();
      const parsed = await parse(
        spreadsheetRows(MAX_LINES - 1, "marca", { coordinates: true }),
      );

      expect(parsed.errors).toEqual([]);
      expect(parsed.unknownHeaders).toEqual([]);
      expect(parsed.rows).toHaveLength(MAX_LINES - 1);
      expect(parsed.rows.every((row) => row.latitude !== null)).toBe(true);
      expect(new Set(parsed.rows.map((row) => row.code)).size).toBe(
        MAX_LINES - 1,
      );
    }, 30_000);

    it("leaves the point to the geocoder without coordinates", async () => {
      const { spreadsheetRows } = await load();
      const parsed = await parse(
        spreadsheetRows(10, "marca", { coordinates: false }),
      );

      expect(parsed.errors).toEqual([]);
      expect(parsed.rows.every((row) => row.latitude === null)).toBe(true);
    });

    it("defaults to 19 999 rows: the importer counts the header in its 20 000", async () => {
      const { MAX_LINES, spreadsheetRows } = await load();

      await expect(
        parse(spreadsheetRows(MAX_LINES, "marca", { coordinates: true })),
      ).rejects.toMatchObject({ code: "SPREADSHEET_TOO_MANY_ROWS" });

      for (const scene of ["import-20k.js", "import-geocode.js"]) {
        expect(read(LOAD, scene)).toContain("__ENV.IMPORT_ROWS || 19_999");
      }
    });
  });

  describe("the fake geocoder", () => {
    type Fake = import("node:http").Server;

    const load = async () =>
      import(
        pathToFileURL(resolve(LOAD, "fake-geocoder.mjs")).href
      ) as Promise<{
        STARTUP: { perSecond: number; perDay: number };
        createFakeGeocoder(options: {
          perSecond?: number;
          perDay?: number;
          latencyMs?: number;
          now?: () => number;
          tls?: { key: string; cert: string } | null;
        }): Fake;
        mintCertificate(
          forgeDir: string,
          hosts: string[],
        ): Promise<{ ca: string; cert: string; key: string }>;
      }>;

    let server: Fake | undefined;

    afterEach(async () => {
      await new Promise((done) => server?.close(done) ?? done(undefined));
      server = undefined;
    });

    async function start(
      options: Parameters<
        Awaited<ReturnType<typeof load>>["createFakeGeocoder"]
      >[0],
    ) {
      const { createFakeGeocoder } = await load();

      server = createFakeGeocoder({ latencyMs: 0, ...options });
      await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));

      const address = server.address() as { port: number };

      return `http://127.0.0.1:${address.port}`;
    }

    it("answers the search the API sends with a point the API reads as an address", async () => {
      const base = await start({});
      const { searchUrl, parseNominatimSearch } =
        await import("@/shared/services/proof-location/address-geocoder");
      const url = searchUrl(
        { url: base, key: undefined, keyParam: "key" },
        {
          street: "Rua Carga marca",
          address_number: "12",
          neighborhood: "Centro",
          city: "Sao Paulo",
          uf: "SP",
          cep: "01001000",
        },
      );

      const point = parseNominatimSearch(await (await fetch(url)).json());

      expect(point?.precision).toBe("ADDRESS");
      expect(point!.latitude).toBeGreaterThan(-24);
      expect(point!.latitude).toBeLessThan(-23);

      const stats = await (
        await fetch(`${base}/stats?contains=${encodeURIComponent("marca")}`)
      ).json();

      expect(stats).toMatchObject({ answered: 1, matching: 1, refused: 0 });
    });

    it("refuses past the plan's second and day, in LocationIQ's words", async () => {
      let now = 1_000_000;
      const base = await start({ perSecond: 2, perDay: 3, now: () => now });
      const search = async () => {
        const response = await fetch(`${base}/search?q=Rua%20A`);

        return { status: response.status, body: await response.json() };
      };

      expect((await search()).status).toBe(200);
      expect((await search()).status).toBe(200);
      expect(await search()).toEqual({
        status: 429,
        body: { error: "Rate Limited Second" },
      });

      now += 1_000;

      expect((await search()).status).toBe(200);
      expect(await search()).toEqual({
        status: 429,
        body: { error: "Rate Limited Day" },
      });

      const stats = await (await fetch(`${base}/stats`)).json();

      expect(stats).toMatchObject({
        answered: 3,
        refused: 2,
        refusedSecond: 1,
        refusedDay: 1,
        maxPerSecond: 2,
      });
    });

    it("serves HTTPS under a CA of its own, which a client trusts only when given it", async () => {
      const { mintCertificate } = await load();
      const minted = await mintCertificate(
        resolve(ROOT, "node_modules", "node-forge"),
        ["fake-geocoder", "localhost"],
      );
      const { X509Certificate } = await import("node:crypto");
      const https = await import("node:https");

      expect(new X509Certificate(minted.ca).ca).toBe(true);
      expect(new X509Certificate(minted.cert).subjectAltName).toContain(
        "DNS:fake-geocoder",
      );

      const port = new URL(await start({ tls: minted })).port;
      const get = (ca?: string) =>
        new Promise<number>((done, fail) => {
          https
            .get(`https://localhost:${port}/health`, { ca }, (response) => {
              response.resume();
              done(response.statusCode ?? 0);
            })
            .on("error", fail);
        });

      expect(await get(minted.ca)).toBe(200);
      await expect(get()).rejects.toThrow();
    });

    it("defaults to the Startup plan the env file writes down", async () => {
      const { STARTUP } = await load();
      const startup = read(LOAD, "geocoder-startup.env");

      expect(startup).toContain(
        `LOCATIONIQ_RATE_PER_SECOND=${STARTUP.perSecond}`,
      );
      expect(startup).toContain(`LOCATIONIQ_DAILY_QUOTA=${STARTUP.perDay}`);
      expect(harness).toContain(
        `FAKE_GEOCODER_PER_SECOND: \${LOAD_FAKE_GEOCODER_PER_SECOND:-${STARTUP.perSecond}}`,
      );
      expect(harness).toContain(
        `FAKE_GEOCODER_PER_DAY: \${LOAD_FAKE_GEOCODER_PER_DAY:-${STARTUP.perDay}}`,
      );
      // Never a real provider, nor a key, in the file; the fake over
      // HTTPS, as production demands, under the run's CA.
      expect(startup).toContain(
        "REVERSE_GEOCODER_URL=https://fake-geocoder:8090",
      );
      expect(startup).toContain("NODE_EXTRA_CA_CERTS=/fakes/ca.pem");
      expect(startup).not.toMatch(/KEY=|locationiq\.com/i);
    });
  });

  it("publishes Redis on loopback only, for the flood's process", () => {
    expect(harness).toContain('- "127.0.0.1:${LOAD_REDIS_PORT:-56379}:6379"');
  });

  describe.skipIf(!hasCompose)("as docker compose renders it", () => {
    it("calls the fake geocoder at the Startup plan only with the scene's env file", () => {
      const services = renderWith(
        ["--profile", "fakes", "--profile", "roles"],
        {
          LOAD_API_ENV_FILE: "geocoder-startup.env",
        },
      );
      const burnIn = read(LOAD, "staging-burn-in.sh").match(
        /NODE_IMAGE="(node:[^"]+@sha256:[0-9a-f]{64})"/,
      );

      expect(services["fake-geocoder"].image).toBe(burnIn?.[1]);
      expect(
        (services["fake-geocoder"] as { ports?: unknown[] }).ports ?? [],
      ).toEqual([]);

      for (const name of ["api", "worker"]) {
        const parsed = envSchema.safeParse(
          definedEnv(services[name].environment ?? {}),
        );

        expect(
          parsed.success,
          `${name}: ${JSON.stringify(parsed.error?.format())}`,
        ).toBe(true);
        expect(parsed.data?.REVERSE_GEOCODER_URL).toBe(
          "https://fake-geocoder:8090",
        );
        expect(services[name].environment?.NODE_EXTRA_CA_CERTS).toBe(
          "/fakes/ca.pem",
        );
        // After the fake wrote its CA: Node reads the trust once, at start.
        expect(
          (services[name].depends_on as Record<string, object> | undefined)?.[
            "fake-geocoder"
          ],
        ).toMatchObject({ condition: "service_healthy", required: false });
        expect(parsed.data?.GEOCODING_CALLS_PER_SECOND).toBe(17);
        expect(parsed.data?.DELIVERY_GEOCODING_DAILY_BUDGET).toBe(45_000);
      }

      const plain = renderWith([]);

      expect(plain["fake-geocoder"]).toBeUndefined();
      expect(plain.api.environment).not.toHaveProperty("REVERSE_GEOCODER_URL");
      expect(plain.api.environment).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    });

    it("leaves the external lane to the flood's process with LOAD_WORKER_QUEUES", () => {
      const services = renderWith(["--profile", "roles"], {
        LOAD_API_ROLE: "api",
        LOAD_WORKER_QUEUES: "outbox,internal,webhooks,ai",
      });
      const worker = envSchema.parse(
        definedEnv(services.worker.environment ?? {}),
      );
      const api = envSchema.parse(definedEnv(services.api.environment ?? {}));

      expect(worker.WORKER_QUEUES).toEqual([
        "outbox",
        "internal",
        "webhooks",
        "ai",
      ]);
      expect(api.WORKER_QUEUES).toEqual([]);
    });
  });
});

/**
 * plano-escala LOAD-10: cpu-profile.sh recreates the api replicas with
 * --cpu-prof through LOAD_API_NODE_FLAGS. Only the replicas behind Traefik
 * may read it: a profiler in the migrate would profile the migrations, and
 * in the worker or the realtime a process nobody asked about.
 */
describe.skipIf(!hasCompose)("the CPU profile's flags (LOAD-10)", () => {
  const flags = "--cpu-prof --cpu-prof-dir=/tmp/cpu-prof";
  const options = (services: Record<string, RoleService>, name: string) =>
    services[name]?.environment?.NODE_OPTIONS ?? "";

  it("are empty by default, the heap ceiling as before", () => {
    const services = renderWith([]);

    expect(options(services, "api")).toBe("--max-old-space-size=768");
  });

  it("reach the api replicas' NODE_OPTIONS and no other service's", () => {
    const services = renderWith(
      ["--profile", "roles", "--profile", "realtime"],
      { LOAD_API_NODE_FLAGS: flags },
    );

    expect(options(services, "api")).toBe(`--max-old-space-size=768 ${flags}`);

    for (const name of ["migrate", "worker", "realtime"]) {
      expect(options(services, name), name).toMatch(
        /^--max-old-space-size=\d+$/,
      );
    }
  });
});

/**
 * The routes of the roles by Path (plano-escala F5-26).
 *
 * On staging and production the realtime and the ingest are reached on the
 * API's host by Domains with a Path, which Dokploy writes as file routers
 * with no priority: Traefik orders them by the length of their rule. The
 * harness loads the same shape for one host (tests/load/traefik), and
 * tests/load/roles-routing.sh proves the order through the access log and
 * that the ingest's Path answers 502 with no replica. Text where the files
 * are config; the script run for real against stubs of curl and docker
 * that play Traefik.
 */
describe("the routes by Path, as Dokploy writes them (F5-26)", () => {
  const routes = read(LOAD, "traefik", "dokploy-roles.yml");

  it("loads the file routers beside the docker labels", () => {
    expect(harness).toContain(
      "--providers.file.directory=/etc/traefik/dynamic",
    );
    expect(harness).toContain("./traefik:/etc/traefik/dynamic:ro");
  });

  it("names, matches and serves each role as Dokploy does, with no priority and nothing stripped", () => {
    for (const [role, rule] of [
      ["api", "Host(`roles.load.localhost`)"],
      ["realtime", "Host(`roles.load.localhost`) && PathPrefix(`/socket.io`)"],
      [
        "ingest",
        "Host(`roles.load.localhost`) && PathPrefix(`/route/positions`)",
      ],
    ]) {
      expect(routes).toContain(
        `trajetto-${role}-router-1:\n      rule: ${rule}\n      service: trajetto-${role}-service-1\n`,
      );
      expect(routes).toContain(
        `trajetto-${role}-service-1:\n      loadBalancer:\n        servers:\n          - url: http://${role}:3333\n        passHostHeader: true`,
      );
    }

    // Traefik's order is the rule's length, as in Dokploy's files.
    expect(routes).not.toMatch(/^\s+priority:/m);
    expect(routes).not.toMatch(/stripprefix|stripPrefix/);
  });

  it("leaves the realtime's own label without a priority, so the roles' host wins its requests", () => {
    expect(harness).not.toContain("load-realtime.priority");
  });

  it("reaches the ingest only through the file router", () => {
    const start = harness.indexOf("\n  ingest:\n");
    const ingest = harness.slice(
      start,
      start + 1 + harness.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/),
    );

    expect(ingest).not.toContain("labels:");
    expect(ingest).toContain("- edge");
  });

  describe.skipIf(!hasShell("bash"))("roles-routing.sh", () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      box.stub("sleep", "exit 0");
    });

    afterEach(() => box.dispose());

    /**
     * Traefik in two stubs: curl answers by the path and writes the access
     * log line of the router that served it; docker reads that log and
     * stops or starts the ingest. `socket` names the router /socket.io
     * lands on, `downStatus` what /route/positions answers with no ingest.
     */
    function traefik(options: { socket?: string; downStatus?: number } = {}) {
      const socket = options.socket ?? "trajetto-realtime-router-1";
      const downStatus = options.downStatus ?? 502;

      box.stub(
        "curl",
        [
          'method=GET; url=""',
          "while [ $# -gt 0 ]; do",
          '  case "$1" in',
          "    -X) method=$2; shift 2 ;;",
          "    -H|-o|-w|--max-time|--data) shift 2 ;;",
          "    -s) shift ;;",
          "    *) url=$1; shift ;;",
          "  esac",
          "done",
          "path=${url#http://localhost:8080}",
          `down=$(cat "${box.root}/ingest-down" 2>/dev/null)`,
          'case "$path" in',
          `  /socket.io*) router=${socket}; status=400 ;;`,
          "  /route/positions*)",
          "    router=trajetto-ingest-router-1",
          `    if [ "$down" = 1 ]; then status=${downStatus}; else status=401; fi ;;`,
          "  *) router=trajetto-api-router-1; status=200 ;;",
          "esac",
          `printf '{"RequestPath":"%s","RouterName":"%s@file","DownstreamStatus":%s}\\n' "$path" "$router" "$status" >> "${box.root}/access.log"`,
          'printf "%s" "$status"',
        ].join("\n"),
      );
      box.stub(
        "docker",
        [
          'case "$1" in',
          `  logs) cat "${box.root}/access.log" ;;`,
          `  stop) echo 1 > "${box.root}/ingest-down" ;;`,
          `  start) echo 0 > "${box.root}/ingest-down" ;;`,
          "esac",
        ].join("\n"),
      );
    }

    const routing = () =>
      run("bash", resolve(LOAD, "roles-routing.sh"), [], {
        bin: box.bin,
        env: {
          ROUTING_TRAEFIK_CONTAINER: "wfl-traefik",
          ROUTING_INGEST_CONTAINER: "wfl-ingest",
          ROUTING_WAIT_SECONDS: "2",
        },
      });

    it("passes when every Path lands on its role and the ingest at 0 answers 502", () => {
      traefik();

      const result = routing();

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "ok: 2. o realtime em /socket.io pelo trajetto-realtime-router-1",
      );
      expect(result.stdout).toContain(
        "ok: 4. /route/live fica na API pelo trajetto-api-router-1",
      );
      expect(result.stdout).toContain(
        "ok: 5a. /route/positions sem ingest pelo trajetto-ingest-router-1 (HTTP 502)",
      );
      expect(box.calls("docker")).toEqual(
        expect.arrayContaining([
          "docker stop wfl-ingest",
          "docker start wfl-ingest",
        ]),
      );
    });

    it("fails when the API's router takes /socket.io (a priority that beats the Path)", () => {
      traefik({ socket: "trajetto-api-router-1" });

      const result = routing();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "FALHOU: 2. o realtime em /socket.io: atendido por 'trajetto-api-router-1@file', esperado trajetto-realtime-router-1",
      );
    });

    it("fails when the ingest's Path does not answer 502 with no replica", () => {
      traefik({ downStatus: 401 });

      const result = routing();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "FALHOU: 5a. o ingest em 0 réplicas não deu 502",
      );
    });
  });
});

/**
 * The scenes of the 5M gate (plano-escala LOAD-11, section 6): the
 * positions at 500 POST/s in an ABBA of the group commit and the session
 * cache, the 10× headroom counted in the database, and a day of the queues
 * drained and dropped under load. The numbers come only on the target
 * hardware; what can go wrong before that is quiet: a scene that follows
 * the server's hint measures another rate than the gate's, an arm whose
 * variables never reached the replicas compares A with A, a count that
 * trusts k6 instead of the database cannot see a lost point, and a DROP
 * pointed by the repository's .env at another database drops a real day.
 * So the k6 scene is read, the DROP scene refuses before connecting, and
 * the ABBA script runs for real with docker stubbed.
 */
describe("the 5M gate's scenes (LOAD-11)", () => {
  const readme = read(LOAD, "README.md");
  const section = readme.slice(
    readme.indexOf("### As cenas do portão do 5M (LOAD-11)"),
  );
  const positions = read(LOAD, "positions-5m.js");
  const drop = read(LOAD, "queue-drop-under-load.mjs");
  const tsxCli = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

  it.each([
    "positions-5m.js",
    "positions-abba.sh",
    "queue-drop-under-load.mjs",
  ])("%s is in the README's table of the 5M gate's scenes", (scene) => {
    expect(section).toMatch(
      new RegExp(`\\| \`${scene.replace(".", "\\.")}\` +\\|`),
    );
  });

  it("holds the gate's rate, 500 POST/s of 4 points, whatever the answers say", () => {
    expect(positions).toContain('executor: "constant-arrival-rate"');
    expect(positions).toContain("Number(__ENV.POSITIONS_5M_RATE || 500)");
    expect(positions).toContain("Number(__ENV.POSITIONS_5M_POINTS || 4)");
    // No pause on the hint: positions.js is the fleet at the server's pace.
    expect(positions).not.toMatch(/\bsleep\(/);
    expect(positions).not.toContain("nextFlushAfterMs");
  });

  it("tags every sample with its arm and counts what the API says it stored", () => {
    expect(positions).toContain("tags: ARM ? { arm: ARM } : {}");
    expect(positions).toContain('response.json("data.stored")');
    expect(positions).toContain("POSITIONS_5M_WINDOW");
  });

  it("puts the gate's acceptance behind POSITIONS_5M_ACCEPTANCE", () => {
    expect(positions).toContain('__ENV.POSITIONS_5M_ACCEPTANCE === "true"');
    expect(positions).toContain(
      '"surface_latency{surface:route.positions}": ["p(95)<150"]',
    );
    expect(positions).toContain(
      '"surface_failures{surface:route.positions}": ["rate==0"]',
    );
    expect(positions).toContain('dropped_iterations: ["count==0"]');
  });

  it("pins every database URL of the app to the disposable one before the app loads", () => {
    const pin = drop.indexOf('"BATCH_DATABASE_URL",');
    const load = drop.indexOf('import("../../src/');

    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThan(load);

    for (const name of [
      '"DATABASE_READ_URL",',
      '"READINESS_DATABASE_URL",',
      '"DATABASE_REPLICA_URL"',
      '"PGBOUNCER_STATS_URL"',
    ]) {
      expect(drop.indexOf(name), name).toBeGreaterThan(0);
      expect(drop.indexOf(name), name).toBeLessThan(load);
    }
  });

  it("drops the chosen day only, through the family's own gate", () => {
    expect(drop).toContain("partition.name === `${parent}_${stamp}`");
    expect(drop).toContain("? gate.mayDrop(parent, partition)");
    expect(drop).toContain(
      '"webhook-deliveries": { mayDrop: async () => false }',
    );
    expect(drop).toContain("FAMILY.includes(table.table)");
    // Never a day the API writes into.
    expect(drop).toContain("day >= today - DAY_MS && day <= today + DAY_MS");
  });

  it("queue-drop-under-load.mjs refuses a database that is not the disposable one, before connecting", () => {
    expect(
      drop.indexOf("assertDisposableDatabase(env.DATABASE_URL"),
    ).toBeLessThan(drop.indexOf("new pg.Client"));

    const result = spawnSync(
      process.execPath,
      [tsxCli, resolve(LOAD, "queue-drop-under-load.mjs")],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://load:load@db.example.com:5432/load_test",
          LOAD_PG_PORT: "",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Só no banco descartável");
  }, 60_000);

  it("keeps the ABBA script executable on any checkout", () => {
    const listed = spawnSync(
      "git",
      ["ls-files", "-s", "tests/load/positions-abba.sh"],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(listed.stdout).toMatch(/^100755 /);
  });

  /**
   * docker, as the harness answers positions-abba.sh. The env file of the
   * last `up` is kept (the replicas' environment that inspect shows); k6
   * writes the summary and the window line in its logfmt; psql answers the
   * commits, the count of the window (the points k6 stored, or one fewer
   * with STUB_LOST) and the ops_sample of the arm.
   */
  const DOCKER = `
state="$STUB_STATE"
case "$1" in
  context) echo "npipe:////./pipe/docker_engine" ;;
  info) case "$*" in *LocalNodeState*) echo inactive ;; *) echo 12 ;; esac ;;
  service) ;;
  ps)
    case "$*" in
      *service=api*) printf 'api1\\napi2\\n' ;;
      *service=postgres*) echo pg1 ;;
      *service=ingest*) [ -z "\${STUB_INGEST:-}" ] || echo i1 ;;
    esac ;;
  inspect) cat "$state/env" 2>/dev/null ;;
  exec)
    case "$*" in
      *wget*) ;;
      *xact_commit*)
        now=$(( $(cat "$state/commits" 2>/dev/null || echo 1000) + 2500 ))
        echo "$now" > "$state/commits"
        echo "$now" ;;
      *driver_position_v2*)
        if [ -n "\${STUB_LOST:-}" ]; then echo 1999; else echo 2000; fi ;;
      *ops_sample*)
        if grep -q '=on' "$state/env"; then
          echo '{"batches" : 300, "fallbackFlushes" : 0, "breakerOpens" : 0, "cacheHits" : 450, "cacheMisses" : 50}'
        else
          echo '{"batches" : 0, "fallbackFlushes" : 0, "breakerOpens" : 0, "cacheHits" : 0, "cacheMisses" : 0}'
        fi ;;
      *"SELECT 1"*) echo 1 ;;
    esac ;;
  compose)
    case "$*" in
      *" up "*)
        cat "$LOAD_API_ENV_FILE" > "$state/env"
        cat "$LOAD_API_ENV_FILE" >> "$state/ups"
        echo "--" >> "$state/ups" ;;
      *" run "*)
        dir=""; out=""; prev=""; arm=""
        for a in "$@"; do
          case "$a" in
            *:/results) dir="\${a%:/results}" ;;
            POSITIONS_5M_ARM=*) arm="\${a#POSITIONS_5M_ARM=}" ;;
          esac
          [ "$prev" != "--summary-export" ] || out="\${a#/results/}"
          prev="$a"
        done
        if [ "$arm" = B ]; then p95=30; else p95=31; fi
        printf '{"metrics":{"http_reqs":{"count":500},"positions_points_stored":{"count":2000},"surface_latency{surface:route.positions}":{"p(95)":%s},"surface_failures{surface:route.positions}":{"value":0}}}' "$p95" > "$dir/$out"
        printf '%s\\n' 'time="2026-11-19T10:10:00Z" level=info msg="POSITIONS_5M_WINDOW {\\"from\\":\\"2026-11-19T10:00:00.000Z\\",\\"to\\":\\"2026-11-19T10:10:00.000Z\\",\\"arm\\":\\"'"$arm"'\\"}" source=console' ;;
    esac ;;
esac
exit 0`;

  describe.skipIf(!hasShell("bash"))(
    "positions-abba.sh",
    { timeout: 120_000 },
    () => {
      let box: Sandbox;
      let base: Record<string, string>;

      beforeEach(() => {
        box = sandbox();
        box.stub("docker", DOCKER);
        box.stub("sleep", "exit 0");
        box.file("state/.keep", "");
        base = {
          STUB_STATE: `${box.root}/state`,
          LOAD_ENV_FILE: box.file(
            "harness.env",
            "JWT_SECRET=x\nJWT_SECRET_REFRESH_TOKEN=y\n",
          ),
          LOAD_CONTEXT_FILE: box.file("load-context.json", "{}"),
          POSITIONS_ABBA_WORK: `${box.root}/work`,
          BENCH_DOKPLOY_DIR: `${box.root}/no-dokploy`,
          DOCKER_HOST: "",
        };
      });

      afterEach(() => box.dispose());

      const abba = (env: Record<string, string> = {}) =>
        run("bash", repoFile("tests/load/positions-abba.sh"), [], {
          bin: box.bin,
          env: { ...base, ...env },
        });

      it("refuses an order that is not as many A as B, two of each, before docker", () => {
        for (const order of ["AB", "AAB", "ABXA"]) {
          expect(abba({ POSITIONS_ABBA_ORDER: order }).status, order).toBe(2);
        }

        expect(abba({ POSITIONS_ABBA_CACHE_TTL_MS: "20000" }).status).toBe(2);
        expect(box.calls("docker")).toEqual([]);
      });

      it("refuses with the ingest profile up: the arm would not reach the route", () => {
        const result = abba({ STUB_INGEST: "1" });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("perfil ingest");
        expect(
          box.calls("docker").filter((call) => call.includes(" up ")),
        ).toEqual([]);
      });

      it("recreates the api with each arm's variables in ABBA and passes when nothing was lost", () => {
        const result = abba();

        expect(result.status, result.stderr + result.stdout).toBe(0);

        const ups = readFileSync(`${box.root}/state/ups`, "utf8")
          .replace(/\r\n/g, "\n")
          .split("--\n")
          .filter(Boolean);

        expect(ups).toEqual([
          "POSITION_GROUP_COMMIT=off\nSESSION_CACHE_TTL_MS=0\n",
          "POSITION_GROUP_COMMIT=on\nSESSION_CACHE_TTL_MS=15000\n",
          "POSITION_GROUP_COMMIT=on\nSESSION_CACHE_TTL_MS=15000\n",
          "POSITION_GROUP_COMMIT=off\nSESSION_CACHE_TTL_MS=0\n",
        ]);

        const session = JSON.parse(
          readFileSync(`${box.root}/work/session.json`, "utf8"),
        );

        expect(session.runs.map((each: { arm: string }) => each.arm)).toEqual([
          "A",
          "B",
          "B",
          "A",
        ]);
        expect(session.runs[0]).toMatchObject({
          dbPoints: 2000,
          commits: 2500,
          from: "2026-11-19T10:00:00.000Z",
          to: "2026-11-19T10:10:00.000Z",
        });

        const verdict = JSON.parse(
          readFileSync(`${box.root}/work/verdict.json`, "utf8"),
        );

        expect(verdict.pass).toBe(true);
        expect(verdict.arms.B.cacheHitRate).toBe(0.9);
      });

      it("fails when the database has fewer points than the API said it stored", () => {
        const result = abba({ STUB_LOST: "1" });

        expect(result.status).toBe(1);

        const verdict = JSON.parse(
          readFileSync(`${box.root}/work/verdict.json`, "utf8"),
        );

        expect(verdict.reasons).toContain(
          "corrida 1 (A): 2000 pontos respondidos com 200 e 1999 no banco",
        );
      });
    },
  );
});
