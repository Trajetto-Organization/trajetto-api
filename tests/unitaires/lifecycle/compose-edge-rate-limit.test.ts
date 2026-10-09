import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CLOUDFLARE_EDGE_CIDRS, isCloudflareEdge } from "@/config/trusted-edge";
import { envSchema } from "@/schemas/env-schema";

/**
 * Which client address production counts, as deployed.
 *
 * Production is Cloudflare -> Traefik -> API. The compose defaulted to `xff`,
 * which behind Cloudflare keys every user by the edge that served them: one
 * login bucket for thousands of people, and a handful of attempts a minute
 * locking all of them out. `cloudflare` is now verified against the edge
 * ranges, so it is the safe default in every topology.
 */
const compose = readFileSync(
  resolve(process.cwd(), "compose.production.yaml"),
  "utf8",
);

function apiService(): string {
  const start = compose.indexOf("\n  api:");
  expect(start, "serviço api não encontrado").toBeGreaterThan(-1);

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\r?\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the API's client-address mode in production", () => {
  it("defaults to the verified Cloudflare mode", () => {
    expect(apiService()).toMatch(
      /RATE_LIMIT_TRUSTED_PROXY: \$\{RATE_LIMIT_TRUSTED_PROXY:-cloudflare\}/,
    );
  });

  it("passes the optional edge secret through, empty when unset", () => {
    expect(apiService()).toMatch(
      /RATE_LIMIT_EDGE_SECRET: \$\{RATE_LIMIT_EDGE_SECRET:-\}/,
    );
  });
});

const production = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "r2",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET_NAME: "b",
  R2_ACCESS_KEY_ID: "c",
  R2_SECRET_ACCESS_KEY: "d",
  RATE_LIMIT_TRUSTED_PROXY: "cloudflare",
};

function issuesFor(overrides: Record<string, string | undefined>): string[] {
  const result = envSchema.safeParse({ ...production, ...overrides });

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("RATE_LIMIT_EDGE_SECRET", () => {
  it("is optional, and an empty value counts as absent", () => {
    expect(issuesFor({})).toEqual([]);
    expect(issuesFor({ RATE_LIMIT_EDGE_SECRET: "" })).toEqual([]);
  });

  it("refuses a secret too short to be one", () => {
    expect(issuesFor({ RATE_LIMIT_EDGE_SECRET: "curto" })).toContain(
      "RATE_LIMIT_EDGE_SECRET",
    );
  });
});

describe("the Cloudflare edge list", () => {
  it("recognises Cloudflare's IPv4 and IPv6 edges", () => {
    expect(isCloudflareEdge("172.70.1.1")).toBe(true);
    expect(isCloudflareEdge("162.158.9.9")).toBe(true);
    expect(isCloudflareEdge("2606:4700:10::6816:1")).toBe(true);
    expect(isCloudflareEdge("::ffff:104.16.0.1")).toBe(true);
  });

  /**
   * An overlay or ingress range here would turn the Swarm routing mesh into
   * a spoof: with ingress SNAT every peer is 10.0.0.x, and trusting it would
   * hand CF-Connecting-IP to whoever writes it.
   */
  it("never trusts a private, loopback or overlay address", () => {
    for (const address of [
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "127.0.0.1",
      "::1",
      "fd00::1",
    ]) {
      expect(isCloudflareEdge(address), address).toBe(false);
    }
  });

  it("answers no to anything that is not an address", () => {
    expect(isCloudflareEdge("unknown")).toBe(false);
    expect(isCloudflareEdge("")).toBe(false);
  });

  it("is well-formed", () => {
    expect(CLOUDFLARE_EDGE_CIDRS.length).toBeGreaterThan(10);

    for (const cidr of CLOUDFLARE_EDGE_CIDRS) {
      expect(cidr).toMatch(/^[\da-f.:]+\/\d{1,3}$/);
    }
  });
});
