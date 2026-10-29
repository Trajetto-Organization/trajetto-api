import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { docsAccessFor } from "@/shared/integration/docs-access";

/**
 * The internal reference behind HTTP Basic, and what stands between it and
 * somebody guessing.
 *
 * `/docs` is the complete map of the product, master-only routes included.
 * Its routes were created before the rate-limit plugin loaded, so they had no
 * limit at all — a password could be tried as fast as the network allowed —
 * and any password was accepted as long as one was set.
 */
describe("the credential that opens the internal reference", () => {
  it("does not open on a short password", () => {
    // A password somebody can guess is a map somebody can read. Closed, like
    // a half configuration, rather than open on a weak one.
    const access = docsAccessFor("production", {
      user: "equipe",
      password: "curta",
    });

    expect(access.kind).toBe("disabled");
  });

  it("opens on a long one", () => {
    const access = docsAccessFor("production", {
      user: "equipe",
      password: "uma-senha-longa-de-verdade-24",
    });

    expect(access.kind).toBe("basic");
  });
});

describe("the internal reference's routes", () => {
  let app: Awaited<typeof import("@/http")>["app"];

  beforeAll(async () => {
    ({ app } = await import("@/http"));
    await app.ready();
  }, APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  });

  it("are rate limited like every other route", async () => {
    for (const url of ["/docs", "/docs/json"]) {
      const response = await app.inject({ method: "GET", url });

      expect(response.headers["x-ratelimit-limit"], url).toBeDefined();
    }
  });
});
