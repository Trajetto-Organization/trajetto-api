import { describe, expect, it } from "vitest";

import { CLOUDFLARE_EDGE_CIDRS, isCloudflareEdge } from "@/config/trusted-edge";
import { envSchema } from "@/schemas/env-schema";

/**
 * Which client address production counts, as deployed.
 *
 * Production is Cloudflare -> Traefik -> API. The old compose defaulted to
 * `xff`, which behind Cloudflare keys every user by the edge that served
 * them: one login bucket for thousands of people, and a handful of attempts a
 * minute locking all of them out. `cloudflare` is now verified against the
 * edge ranges, and production refuses to boot without an explicit mode (set
 * in the API Application's environment in Dokploy).
 */

const production = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
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

describe("RATE_LIMIT_TRUSTED_PROXY in production", () => {
  it("must be set: no deploy default picks the mode any more", () => {
    // The compose used to supply `cloudflare`; an Application has only what
    // its environment says, so the schema is what refuses the gap.
    expect(issuesFor({ RATE_LIMIT_TRUSTED_PROXY: undefined })).toContain(
      "RATE_LIMIT_TRUSTED_PROXY",
    );
    expect(issuesFor({})).toEqual([]);
  });
});

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
