import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The API's runtime connection gives up on a dead peer (GAP6-4).
 *
 * The production DATABASE_URL carried no socket_timeout and no idle lifetime.
 * A pooled connection whose peer vanished without a FIN or RST — a node lost,
 * a partition, or the Swarm VIP (IPVS) forgetting a flow idle for 900 s —
 * kept its request waiting until the kernel gave up on the socket, about
 * fifteen minutes, and every other request queued behind the pool got P2024.
 *
 * tests/E2E/runtime-database-dead-peer.test.ts proves what each parameter
 * does against a real Postgres; this file pins the values, and runs in the
 * branch CI, where there is no database.
 */
const compose = readFileSync(resolve(process.cwd(), "compose.production.yaml"), "utf8");

/** Swarm's IPVS drops an idle TCP flow after 900 s (ipvsadm --timeout). */
const IPVS_IDLE_TIMEOUT_SECONDS = 900;

function apiVariable(name: string): string {
  const api = compose.slice(compose.indexOf("\n  api:"));
  const value = api.match(new RegExp(`^\\s+${name}: (.+?)\\s*$`, "m"))?.[1];

  expect(value, `${name} do serviço api`).toBeTruthy();

  return value as string;
}

const PLACEHOLDERS: Record<string, string> = {
  POSTGRES_USERNAME: "user",
  POSTGRES_PASSWORD: "secret",
  POSTGRES_HOST: "database",
  POSTGRES_PORT: "5432",
  POSTGRES_DATABASE: "trajetto",
};

/** The compose value as a URL, with its ${...} filled with placeholders. */
function parsed(name: string): URL {
  return new URL(
    apiVariable(name).replace(/\$\{(\w+)[^}]*\}/g, (_, key: string) => PLACEHOLDERS[key] ?? "x"),
  );
}

function seconds(url: URL, parameter: string): number {
  const value = url.searchParams.get(parameter);

  expect(value, `${parameter} na URL`).not.toBeNull();

  return Number(value);
}

/** statement_timeout from `options` (milliseconds in the URL), in seconds. */
function statementTimeoutSeconds(url: URL): number {
  const match = (url.searchParams.get("options") ?? "").match(/statement_timeout=(\d+)/);

  expect(match, "statement_timeout em options").not.toBeNull();

  return Number(match![1]) / 1000;
}

describe("the API's runtime DATABASE_URL", () => {
  const runtime = parsed("DATABASE_URL");

  it("bounds a query that never gets an answer, above the server's own ceiling", () => {
    const socketTimeout = seconds(runtime, "socket_timeout");

    // Above statement_timeout: a live server cancels a slow statement first
    // and the request gets Postgres' own error. Only a peer that stopped
    // answering at all reaches this bound.
    expect(socketTimeout).toBeGreaterThan(statementTimeoutSeconds(runtime));
    expect(socketTimeout).toBeLessThanOrEqual(120);
  });

  it("never reuses a connection idle long enough for the VIP to forget its flow", () => {
    expect(seconds(runtime, "max_idle_connection_lifetime")).toBeLessThan(
      IPVS_IDLE_TIMEOUT_SECONDS,
    );
  });

  it("gives up on connecting quickly", () => {
    expect(seconds(runtime, "connect_timeout")).toBeLessThanOrEqual(10);
  });
});

describe("the migration URL", () => {
  it("has no socket_timeout: a long CREATE INDEX or backfill must not be cut halfway", () => {
    expect(parsed("MIGRATION_DATABASE_URL").searchParams.has("socket_timeout")).toBe(false);
  });
});
