import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * GET /assets/trajetto-logo.png, through the real app.
 *
 * The logo every e-mail points at. Public — a mail client fetches it with no
 * session — and the ONLY file behind /assets: nothing else of the repository
 * or the image is reachable by guessing a path next to it.
 */
const ROOT = resolve(__dirname, "../../..");
const LOGO = readFileSync(resolve(ROOT, "assets/proof/trajetto-logo.png"));

let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

describe("the e-mail logo", () => {
  it("is served without a session, byte for byte the versioned PNG", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/assets/trajetto-logo.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.equals(LOGO)).toBe(true);
  });

  it("with the headers a mail client and its image proxy need", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/assets/trajetto-logo.png",
    });

    expect(response.headers["cache-control"]).toMatch(
      /^public, max-age=\d{7,}/,
    );
    expect(response.headers["cross-origin-resource-policy"]).toBe(
      "cross-origin",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers.etag).toBeTruthy();
  });

  it("answers a revalidation with 304 and no body", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/assets/trajetto-logo.png",
    });

    const again = await app.inject({
      method: "GET",
      url: "/assets/trajetto-logo.png",
      headers: { "if-none-match": String(first.headers.etag) },
    });

    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it("answers HEAD too", async () => {
    const response = await app.inject({
      method: "HEAD",
      url: "/assets/trajetto-logo.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
  });

  it.each([
    "/assets",
    "/assets/",
    "/assets/proof/trajetto-logo.png",
    "/assets/../package.json",
    "/assets/%2e%2e/package.json",
    "/assets/trajetto-logo.png/x",
    "/assets/other.png",
  ])("exposes nothing else: %s is a 404", async (url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(404);
  });
});
