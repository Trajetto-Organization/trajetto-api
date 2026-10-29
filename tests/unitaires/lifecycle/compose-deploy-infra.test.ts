import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the dev stack is made of, read from compose.development.yaml, and the
 * liveness probe the image carries.
 *
 * Production and staging run as Dokploy Applications (no compose): their
 * replicas, limits, update order and healthcheck are fields of each
 * Application, documented in docs/deploy.md. What still lives in this
 * repository is checked here: the dev compose and the Dockerfile.
 *
 * Text-based on purpose: no YAML parser is a declared dependency, and every
 * assertion here is about a line an operator would read.
 */
const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");

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

describe("the image's liveness probe (GAP6-11)", () => {
  // In Swarm a failing healthcheck DESTROYS the task, so a readiness probe
  // there turned a database blip into 0/2 replicas. The image's HEALTHCHECK
  // (and the API Application's Swarm healthcheck, docs/deploy.md) only asks
  // whether the process itself is alive.
  const dockerfile = read("Dockerfile");
  const healthcheck = dockerfile.slice(dockerfile.indexOf("\nHEALTHCHECK"));

  it("kills a container only when the process itself is gone (liveness)", () => {
    expect(healthcheck.split("\n").slice(0, 3).join("\n")).toContain(
      "/health/liveness",
    );
    expect(healthcheck.split("\n").slice(0, 3).join("\n")).not.toContain(
      "/health/readiness",
    );
  });

  it("probes with busybox wget, not a Node process inside the memory limit", () => {
    // Measured in the base image: `node -e` ~52 MB RSS and ~54 ms CPU per
    // probe, wget ~1 MB and ~1 ms; both exit 1 on a 5xx or a refusal.
    expect(dockerfile).toContain(
      "CMD wget -q -O /dev/null http://127.0.0.1:3333/health/liveness",
    );
  });
});

describe("the development database (PG-08)", () => {
  it("runs the same major version as production", () => {
    // It ran `bitnami/postgresql` with no tag — PostgreSQL 18, whose skip
    // scan produces plans production (16) never runs, so a query "checked"
    // with EXPLAIN in dev said nothing about production.
    expect(service(development, "trajetto-database")).toMatch(
      /image: "?postgres:16/,
    );
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
      const ports =
        service(development, name).match(
          /\n    ports:\n((?: {6}- .+\n)+)/,
        )?.[1] ?? "";

      expect(ports.trim().length, "ports").toBeGreaterThan(0);

      for (const line of ports.trim().split("\n")) {
        expect(line.trim()).toMatch(/^- "127\.0\.0\.1:\d+:\d+"$/);
      }
    },
  );
});
