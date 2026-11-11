import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import { directives } from "../../support/csp";

/**
 * The files the API serves from disk with @fastify/static, through the real
 * app: swagger-ui's assets under /docs/static/*, and ./tmp (where
 * UPLOAD_STORAGE_TYPE=local writes uploads) under /tmp/* whenever NODE_ENV is
 * not production.
 *
 * @fastify/static 10 changed what `setHeaders` gets (the reply, not the raw
 * response) and when (after the reply's own headers). The /tmp/ hook written
 * for 8.x threw on the first file, and a line-for-line port put "*" over the
 * origin the CORS plugin had answered.
 */
const ROOT = resolve(__dirname, "../../..");
const FILE = `static-assets-${randomUUID()}.txt`;
const CONTENT = "static assets probe";

// Any loopback port is an allowed origin outside production (cors-origin.ts).
const ALLOWED_ORIGIN = "http://localhost:4100";

let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  writeFileSync(resolve(ROOT, "tmp", FILE), CONTENT);
  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  rmSync(resolve(ROOT, "tmp", FILE), { force: true });
});

describe("the internal reference under helmet's policy", () => {
  it("loads every script and stylesheet from /docs/static, none inline", async () => {
    // helmet answers every route with `script-src 'self'` and
    // `script-src-attr 'none'`: an inline script or handler in the page
    // would leave /docs blank, with nothing in the API's log.
    const page = await app.inject({ method: "GET", url: "/docs" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);

    const csp = directives(String(page.headers["content-security-policy"]));

    expect(csp["script-src"]).toContain("'self'");
    expect(csp["style-src"]).toContain("'self'");
    // The initializer swaps the top bar's logo for a data: image.
    expect(csp["img-src"]).toContain("data:");

    const scripts = [
      ...page.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
    ];

    expect(scripts.length).toBeGreaterThan(0);

    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="\/docs\/static\//);
      expect(body.trim()).toBe("");
    }

    expect(page.body).not.toMatch(/\son[a-z]+\s*=/i);

    const assets = [...page.body.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(
      ([, url]) => url,
    );

    expect(assets).toContain("/docs/static/swagger-ui.css");

    // nosniff (helmet) refuses a script or stylesheet sent with another type.
    const types: Record<string, RegExp> = {
      css: /^text\/css/,
      js: /^(application|text)\/javascript/,
      png: /^image\/png/,
    };

    for (const url of assets) {
      expect(url, url).toMatch(/^\/docs\/static\//);

      const asset = await app.inject({ method: "GET", url });

      expect(asset.statusCode, url).toBe(200);
      expect(asset.headers["content-type"], url).toMatch(
        types[url.split(".").pop() ?? ""],
      );
    }
  });
});

describe("the local files under /tmp/", () => {
  it("can be read from another origin's page", async () => {
    const response = await app.inject({ method: "GET", url: `/tmp/${FILE}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(CONTENT);
    expect(response.headers["cross-origin-resource-policy"]).toBe(
      "cross-origin",
    );
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("keep the CORS plugin's answer to an allowed origin", async () => {
    // Up to @fastify/static 9 the reply's headers won over the hook's. With
    // credentials allowed, a browser refuses "*", so the origin must stay.
    const response = await app.inject({
      method: "GET",
      url: `/tmp/${FILE}`,
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      ALLOWED_ORIGIN,
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["cross-origin-resource-policy"]).toBe(
      "cross-origin",
    );
  });
});
