import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * What the production stack (and the dev one) is made of, read from the
 * compose files the deploy uses. The Dokploy stacks (production and staging)
 * run these files, so they are the only place most of these decisions live.
 *
 * Text-based on purpose, like compose-production.test.ts: no YAML parser is a
 * declared dependency, and every assertion here is about a line an operator
 * would read.
 */
const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");

const production = read("compose.production.yaml");
const development = read("compose.development.yaml");

/** A top-level service's block, from its name to the next service. */
function service(compose: string, name: string): string {
  const services = compose.slice(compose.indexOf("\nservices:\n"));
  const start = services.indexOf(`\n  ${name}:\n`);

  expect(start, `serviço ${name} não encontrado`).toBeGreaterThan(-1);

  const rest = services.slice(start + 1);
  const next = rest.slice(1).search(/\n(  [\w-]+:\n|\S)/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** A top-level section (volumes:, networks:) of the file. */
function section(compose: string, name: string): string {
  const start = compose.indexOf(`\n${name}:\n`);

  if (start < 0) return "";

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n\S/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("where the production database may run (INFRA-13, GAP6-7)", () => {
  const database = () => service(production, "trajetto-database");

  it("stays on the node that holds its volume", () => {
    // `postgres_data` is a LOCAL volume. Rescheduled on another node, the
    // task finds an empty one there and initdb makes a brand-new database.
    // `node.role == manager` holds on today's single-node swarm with no label
    // to prepare, and pins the database in the usual 1 manager + N workers.
    expect(database()).toMatch(/placement:\n\s+constraints:\n\s+- node\.role == manager/);
  });

  it("leaves Redis free to move: it holds nothing worth pinning", () => {
    expect(service(production, "trajetto-redis")).not.toMatch(/placement:/);
  });

  it("runs an image the operator can pin, never a tag that moves by itself", () => {
    // A stack redeploy resolves `postgres:16-alpine` again; when upstream has
    // moved the tag, the database restarts on a new minor nobody asked for.
    expect(database()).toMatch(/image: \$\{POSTGRES_IMAGE:-postgres:16-alpine\}/);
  });

  it("still stops the old Postgres before starting the new one", () => {
    // Two postmasters on one PGDATA corrupt it; stop-first is not negotiable.
    expect(database()).toMatch(/update_config:[\s\S]*?order: stop-first/);
    expect(database()).toMatch(/rollback_config:[\s\S]*?order: stop-first/);
  });

  it("lets the API bootstrap an empty database only when told to", () => {
    expect(service(production, "api")).toMatch(
      /ALLOW_EMPTY_DATABASE_BOOTSTRAP: \$\{ALLOW_EMPTY_DATABASE_BOOTSTRAP:-false\}/,
    );
  });
});

describe("memory ceilings on a shared host (INFRA-12)", () => {
  /** The `${VAR:-<n>M}` default of a service's memory limit, in MB. */
  function memoryLimit(block: string): number {
    const limit = block.match(
      /resources:\n\s+limits:\n\s+memory: (?:\$\{\w+:-)?(\d+)M\}?/,
    );

    expect(limit, "deploy.resources.limits.memory").not.toBeNull();

    return Number(limit![1]);
  }

  it("caps the API, with a V8 heap that ends the process before the cgroup does", () => {
    // Everything shares one host: an API that grows without bound (N
    // spreadsheet imports of 13 MB in parallel) competes with Postgres for the
    // same RAM, and the OOM killer's victim is unpredictable. A heap ceiling
    // below the container's turns "SIGKILL somewhere" into a clean heap OOM
    // and a restart of this one replica.
    const api = service(production, "api");
    const limit = memoryLimit(api);
    const heap = api.match(/NODE_OPTIONS: --max-old-space-size=\$\{API_HEAP_MB:-(\d+)\}/);

    expect(heap, "NODE_OPTIONS com --max-old-space-size").not.toBeNull();
    expect(Number(heap![1])).toBeLessThanOrEqual(limit * 0.8);
  });

  it("caps Redis and the backup sidecar", () => {
    expect(memoryLimit(service(production, "trajetto-redis"))).toBeGreaterThan(0);
    expect(memoryLimit(service(production, "trajetto-backup"))).toBeGreaterThan(0);
  });

  it("leaves Postgres uncapped on purpose: it is what the others are capped for", () => {
    // Capping the database without knowing the host's RAM risks the kernel
    // killing Postgres itself; its memory is sized by its own settings (the
    // tuning block, PG-08).
    expect(service(production, "trajetto-database")).not.toMatch(/limits:/);
  });

  it("reserves nothing: on a small host a reservation can leave a task unschedulable", () => {
    expect(production).not.toMatch(/reservations:/);
  });
});

describe("Redis holds nothing durable, and is sized for it (REDIS-11)", () => {
  // Counters with a TTL and the Socket.IO adapter's pub/sub — ADR 0002: the
  // Redis is disposable. The redis:7 defaults were maxmemory 0 with
  // `noeviction` (a full Redis refuses the INCR and every limiter fails) and
  // RDB snapshots onto a volume, which only bring back keys that should be
  // gone.
  const redis = () => service(production, "trajetto-redis");
  const command = () => redis().match(/command: (.+)/)?.[1] ?? "";

  it("never persists", () => {
    expect(command()).toContain("--save ''");
    expect(command()).toContain("--appendonly no");
    const code = (text: string) => text.replace(/^\s*#.*$/gm, "");

    expect(code(redis())).not.toMatch(/redis_data/);
    expect(code(section(production, "volumes"))).not.toMatch(/redis_data/);
  });

  it("evicts instead of refusing writes, within its container's limit", () => {
    // allkeys-lru, not volatile-*: a key without a TTL can never pin memory,
    // and an evicted counter is just an early reset — the fail-open ADR 0002
    // already accepts.
    expect(command()).toContain("--maxmemory-policy allkeys-lru");

    const maxmemory = Number(command().match(/--maxmemory (\d+)mb/)?.[1]);
    const limit = Number(redis().match(/limits:\n\s+memory: (\d+)M/)?.[1]);

    expect(maxmemory).toBeGreaterThan(0);
    expect(maxmemory).toBeLessThanOrEqual(limit * 0.6);
  });

  it("is still replaced stop-first: one pub/sub bus, never two at once", () => {
    expect(redis()).toMatch(/update_config:[\s\S]*?order: stop-first/);
  });
});

describe("the data services stay off the shared network (INFRA-14)", () => {
  const networks = (name: string) =>
    service(production, name).match(/\n    networks:\n((?:      - [\w-]+\n)+)/)?.[1] ?? "";

  it("declares an internal backend network", () => {
    // No route out, and no one outside this stack on it: Traefik, the web
    // and whatever else shares the edge network cannot reach Postgres or Redis.
    expect(section(production, "networks")).toMatch(
      /\n  backend:\n    driver: overlay\n    internal: true\n/,
    );
  });

  it.each(["trajetto-database", "trajetto-redis"])("keeps %s on backend only", (name) => {
    // Phase 2 of the network split, done with the move to Dokploy: that stack
    // is a new one, so no replica of an older release needs the shared leg.
    expect(networks(name)).toBe("      - backend\n");
  });

  it.each(["api", "trajetto-backup"])("puts %s on backend and on the edge", (name) => {
    // The API is reached by Traefik there; the backup reaches R2 through it.
    expect(networks(name)).toContain("- backend");
    expect(networks(name)).toContain("- edge");
  });

  it("joins the network Dokploy's Traefik lives on, by name, not a hard-coded one", () => {
    // `minha_rede` was the Portainer convention; Dokploy's is `dokploy-network`.
    expect(section(production, "networks")).toMatch(
      /\n  edge:\n    external: true\n    name: \$\{TRAEFIK_NETWORK:-dokploy-network\}\n/,
    );
    expect(production).not.toMatch(/minha_rede/);
  });
});

describe("the edge labels, shared by production and staging on one Traefik (DEPLOY-2)", () => {
  const labels = () =>
    service(production, "api")
      .split("\n")
      .filter((line) => /^\s+- traefik\./.test(line))
      .map((line) => line.trim().slice(2));

  it("names every router and service after the stack's ROUTER_PREFIX", () => {
    // Two stacks both defining `routers.api` make Traefik drop the router.
    const names = labels()
      .map((label) => label.match(/^traefik\.http\.(?:routers|services|middlewares)\.([^.]+)\./)?.[1])
      .filter((name): name is string => !!name);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(["${ROUTER_PREFIX}-api"]));
  });

  it("takes the host, the certificate resolver and the network from the stack", () => {
    expect(labels()).toContain(
      "traefik.http.routers.${ROUTER_PREFIX}-api.tls.certresolver=${TRAEFIK_CERTRESOLVER:-letsencrypt}",
    );
    expect(labels().find((label) => label.includes(".rule="))).toMatch(
      /rule=Host\(`\$\{API_HOST:\?[^}]+\}`\)$/,
    );
    expect(labels()).toContain("traefik.swarm.network=${TRAEFIK_NETWORK:-dokploy-network}");
    expect(production).not.toMatch(/letsencryptresolver/);
  });

  it("has no sticky cookie: the socket is WebSocket-only and Redis carries the events", () => {
    expect(labels().some((label) => label.includes("sticky"))).toBe(false);
  });

  it("tells the container which deployment it is, with no default", () => {
    expect(service(production, "api")).toMatch(/\n      APP_ENV: \$\{APP_ENV:\?[^}]+\}\n/);
  });
});

describe("the database volume (DEPLOY-4)", () => {
  it("has an explicit, required name instead of the stack-prefixed one", () => {
    // Unnamed, Swarm calls it <stack>_postgres_data: the same file under
    // Dokploy's app name mounted a new, empty volume.
    expect(section(production, "volumes")).toMatch(
      /\n  postgres_data:\n    name: "\$\{POSTGRES_VOLUME:\?[^}]+\}"\n/,
    );
  });
});

describe.skipIf(!hasShell("sh"))("Redis auth during the first rollout (INFRA-14)", () => {
  /**
   * The replicas of the release before this one reach Redis with no
   * password. When the stack update restarts Redis with requirepass while
   * they still serve, they get NOAUTH — and that release crashes on an
   * adapter publish error. REDIS_ENFORCE_AUTH=false runs Redis without the
   * password for that one rollout; ioredis only warns when it sends AUTH to
   * a Redis that has none. The compose's own scripts run here, with
   * redis-server and redis-cli stubbed.
   */
  const redis = () => service(production, "trajetto-redis");

  /** A `["sh", "-c", "..."]` line of the compose, as the container sees it. */
  function script(line: RegExp): string {
    const found = redis().match(line)?.[1];

    expect(found, String(line)).toBeTruthy();

    return JSON.parse(`"${found!}"`).replace(/\$\$/g, "$");
  }

  let box: Sandbox;

  afterEach(() => box?.dispose());

  function start(env: Record<string, string>) {
    box = sandbox();
    box.stub("redis-server", "exit 0");
    // The image's own entrypoint, minus the drop to the `redis` user it does
    // for real when its first argument is redis-server.
    box.stub("docker-entrypoint.sh", 'exec "$@"');

    const body = box.file("command.sh", script(/command: \["sh", "-c", "(.+)"\]/));

    run("sh", body, [], { bin: box.bin, env: { REDIS_PASSWORD: "pw", ...env } });

    return box.calls("redis-server")[0] ?? "";
  }

  function healthy(env: Record<string, string>, serverHasPassword: boolean) {
    box = sandbox();
    // A Redis without a password answers AUTH with an error. redis-cli 7.4
    // prints it and still sends the PING; a client that stops at the failed
    // AUTH would never get there — the stub plays that stricter one.
    box.stub(
      "redis-cli",
      serverHasPassword
        ? `case "$*" in *"-a pw"*) echo PONG ;; *) echo "NOAUTH Authentication required." ;; esac`
        : `case "$*" in *"-a "*) echo "AUTH failed" >&2; exit 1 ;; *) echo PONG ;; esac`,
    );

    const body = box.file(
      "healthcheck.sh",
      script(/"CMD-SHELL",\n\s+"(.+)",\n/),
    );

    return run("sh", body, [], { bin: box.bin, env: { REDIS_PASSWORD: "pw", ...env } })
      .status === 0;
  }

  it("requires the password by default", () => {
    expect(start({})).toContain("--requirepass pw");
    expect(start({ REDIS_ENFORCE_AUTH: "true" })).toContain("--requirepass pw");
  });

  it("starts through the image's entrypoint, which is what drops root", () => {
    // redis:7's docker-entrypoint.sh re-executes itself as the `redis` user
    // (gosu) only when its first argument is `redis-server`. A command that
    // starts with `sh -c` and execs redis-server directly skips it: Redis ran
    // as root in the container.
    const modes: Array<Record<string, string>> = [{}, { REDIS_ENFORCE_AUTH: "false" }];

    for (const env of modes) {
      start(env);

      expect(box.calls("docker-entrypoint.sh")[0] ?? "", JSON.stringify(env)).toMatch(
        /^docker-entrypoint\.sh redis-server /,
      );

      box.dispose();
    }
  });

  it("can run without it for the first rollout, with the same limits", () => {
    const args = start({ REDIS_ENFORCE_AUTH: "false" });

    expect(args).not.toContain("--requirepass");
    expect(args).toContain("--maxmemory 256mb --maxmemory-policy allkeys-lru");
    expect(args).toContain("--appendonly no");
  });

  it("is called healthy in both modes — and only when PING answers", () => {
    expect(healthy({}, true)).toBe(true);
    expect(healthy({ REDIS_ENFORCE_AUTH: "false" }, false)).toBe(true);
    expect(healthy({}, false)).toBe(false);
  });

  it("passes the switch to the container, secure unless told otherwise", () => {
    expect(redis()).toMatch(/REDIS_ENFORCE_AUTH: \$\{REDIS_ENFORCE_AUTH:-true\}/);
  });
});

describe("no service ever gives up restarting (INFRA-15)", () => {
  // SwarmKit with max_attempts stops recreating a task for good once the
  // budget is spent — with a window too, a fast crash loop (three failures in
  // two minutes) is enough. For single-instance stateful services nothing
  // takes over: giving up only makes the outage outlive its cause. Crash
  // loops are for alerting, not for the orchestrator to end.
  const code = production.replace(/^\s*#.*$/gm, "");

  it("has no max_attempts anywhere", () => {
    expect(code).not.toMatch(/max_attempts:/);
  });

  it.each(["trajetto-database", "trajetto-redis", "api", "trajetto-backup"])(
    "restarts %s on any exit",
    (name) => {
      expect(service(production, name)).toMatch(/restart_policy:\n\s+condition: any/);
    },
  );
});

describe("which probe does what (GAP6-11)", () => {
  // Pinned because the architecture plan said the opposite for a while ("the
  // healthcheck now points to /health/readiness"): in Swarm a failing
  // healthcheck DESTROYS the task, so readiness there turned a database blip
  // into 0/2 replicas. Readiness belongs to Traefik, which only takes the
  // replica out of rotation.
  const api = () => service(production, "api");

  it("kills a container only when the process itself is gone (liveness)", () => {
    const healthcheck = api().slice(api().indexOf("\n    healthcheck:"));

    expect(healthcheck).toContain("http://127.0.0.1:3333/health/liveness");
    expect(healthcheck).not.toContain("/health/readiness");
  });

  it("probes with busybox wget, not a Node process inside the memory limit", () => {
    // Measured in the base image: `node -e` ~52 MB RSS and ~54 ms CPU per
    // probe, wget ~1 MB and ~1 ms; both exit 1 on a 5xx or a refusal.
    const healthcheck = api().slice(api().indexOf("\n    healthcheck:"));

    expect(healthcheck).toContain('test: ["CMD", "wget", "-q", "-O", "/dev/null", ');
    expect(read("Dockerfile")).toContain(
      "CMD wget -q -O /dev/null http://127.0.0.1:3333/health/liveness",
    );
  });

  it("takes an unready replica out of rotation through Traefik (readiness)", () => {
    expect(api()).toContain(
      "traefik.http.services.${ROUTER_PREFIX}-api.loadbalancer.healthcheck.path=/health/readiness",
    );
    expect(api()).toContain(
      "traefik.http.services.${ROUTER_PREFIX}-api.loadbalancer.healthcheck.timeout=5s",
    );
  });

  it("gives the image the same liveness default", () => {
    const dockerfile = read("Dockerfile");
    const healthcheck = dockerfile.slice(dockerfile.indexOf("\nHEALTHCHECK"));

    expect(healthcheck.split("\n").slice(0, 3).join("\n")).toContain("/health/liveness");
  });
});

describe("the development database (PG-08)", () => {
  it("runs the same major version as production", () => {
    // It ran `bitnami/postgresql` with no tag — PostgreSQL 18, whose skip
    // scan produces plans production (16) never runs, so a query "checked"
    // with EXPLAIN in dev said nothing about production.
    expect(service(development, "trajetto-database")).toMatch(/image: "?postgres:16/);
  });
});

describe("the development services (DOCKER-2)", () => {
  it("do not hand the whole API .env (JWT secrets, keys) to the Postgres container", () => {
    // `environment` already maps the three POSTGRES_* it needs.
    expect(service(development, "trajetto-database")).not.toMatch(/env_file:/);
  });

  it.each(["trajetto-database", "trajetto-redis"])(
    "publish %s on the loopback only: dev Redis has no password",
    (name) => {
      const ports = service(development, name).match(/\n    ports:\n((?: {6}- .+\n)+)/)?.[1] ?? "";

      expect(ports.trim().length, "ports").toBeGreaterThan(0);

      for (const line of ports.trim().split("\n")) {
        expect(line.trim()).toMatch(/^- "127\.0\.0\.1:\d+:\d+"$/);
      }
    },
  );
});
