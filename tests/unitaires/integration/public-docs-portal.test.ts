import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The public portal as a browser receives it: the page AND the policy that
 * decides what the page may run.
 *
 * The page passed every test while rendering blank. helmet's default CSP is
 * `script-src 'self'` and `script-src-attr 'none'`: the renderer comes from a
 * CDN and the fallback was an inline `onerror`, so the browser blocked both
 * and the integrator saw an empty page with no link to the raw document. A
 * test of the HTML alone cannot see that; only one that reads the header next
 * to it can.
 *
 * No database: the portal is static.
 */
let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

/** `script-src 'self' https://x` → { "script-src": ["'self'", "https://x"] } */
function directives(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);

        return [name.toLowerCase(), values];
      }),
  );
}

async function portal() {
  const response = await app.inject({
    method: "GET",
    url: "/integration/docs",
  });

  return {
    html: response.body,
    csp: directives(String(response.headers["content-security-policy"] ?? "")),
  };
}

describe("the public documentation portal", () => {
  it("is allowed to load the renderer it references", async () => {
    const { html, csp } = await portal();

    const src = html.match(/<script[^>]*\ssrc="([^"]+)"/)?.[1] ?? "";

    expect(src).toMatch(/^https:\/\/cdn\.jsdelivr\.net\//);
    expect(csp["script-src"]).toContain("https://cdn.jsdelivr.net");
  });

  it("pins the renderer's bytes with subresource integrity", async () => {
    // A CDN-served script with no integrity runs whatever the CDN serves.
    const { html } = await portal();

    const tag = html.match(/<script[^>]*id="api-reference"[^>]*>/)?.[0] ?? "";

    expect(tag).toMatch(/\sintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/);
    expect(tag).toContain('crossorigin="anonymous"');
  });

  it("uses no inline event handler, which the policy forbids", async () => {
    const { html, csp } = await portal();

    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(csp["script-src-attr"]).toEqual(["'none'"]);
  });

  it("allows its inline fallback script by hash and nothing else inline", async () => {
    const { html, csp } = await portal();

    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1],
    );

    expect(inline.length).toBeGreaterThan(0);

    for (const body of inline) {
      const hash = createHash("sha256").update(body).digest("base64");

      expect(csp["script-src"]).toContain(`'sha256-${hash}'`);
    }

    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("registers the fallback before the renderer can fail", async () => {
    // A load error fires once; a listener added after it is a listener that
    // never runs.
    const { html } = await portal();

    expect(html.indexOf("<script>")).toBeGreaterThan(-1);
    expect(html.indexOf("<script>")).toBeLessThan(
      html.indexOf('id="api-reference"'),
    );
  });

  it("keeps the strict policy on every other route", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/catalogue",
    });

    const csp = directives(
      String(response.headers["content-security-policy"] ?? ""),
    );

    expect(csp["script-src"]).toEqual(["'self'"]);
  });
});

/** The attribute as the browser hands it to the renderer (entities decoded). */
function configurationOf(html: string): Record<string, any> | null {
  const raw = html.match(/data-configuration="([^"]*)"/)?.[1];

  if (raw === undefined) return null;

  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
}

/**
 * The console the portal links to (decision 11.2), configured for the page's
 * own policy.
 *
 * It rendered with the renderer's defaults: fonts from the renderer's host,
 * an English interface, the key typed by an integrator kept in the browser's
 * storage, and (in current versions) an AI assistant and an MCP generator
 * pointing at a third party. A browser run with this configuration loaded no
 * resource besides the pinned script and rendered in Portuguese.
 */
describe("the console's configuration", () => {
  it("is handed to the renderer on its own tag", async () => {
    const { html } = await portal();

    const tag = html.match(/<script[^>]*id="api-reference"[^>]*>/)?.[0] ?? "";

    expect(tag).toContain("data-configuration=");
    expect(configurationOf(tag)).not.toBeNull();
  });

  it("loads nothing the page's policy does not name, and keeps no key", async () => {
    const configuration = configurationOf((await portal()).html) ?? {};

    expect(configuration.withDefaultFonts).toBe(false);
    expect(configuration.proxyUrl).toBeUndefined();
    expect(configuration.persistAuth).toBe(false);
    expect(configuration.agent).toEqual({ disabled: true });
    expect(configuration.mcp).toEqual({ disabled: true });
    expect(configuration.telemetry).toBe(false);
  });

  it("speaks Portuguese and asks for the API key", async () => {
    const configuration = configurationOf((await portal()).html) ?? {};

    expect(configuration.localization).toEqual({ locale: "pt-BR" });
    expect(configuration.authentication).toEqual({
      preferredSecurityScheme: "apiKey",
    });
  });

  it("points at the guides when the renderer cannot load", async () => {
    const { renderPublicDocsPage } = await import(
      "@/shared/integration/public-docs"
    );

    const html = renderPublicDocsPage("/integration/docs/openapi.json", {
      portalUrl: "https://www.exemplo.com.br/docs",
    });

    expect(
      html.match(/https:\/\/www\.exemplo\.com\.br\/docs/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps a staging console out of search results, and production's in", async () => {
    const { renderPublicDocsPage } = await import(
      "@/shared/integration/public-docs"
    );

    const url = "/integration/docs/openapi.json";

    expect(renderPublicDocsPage(url, { environment: "staging" })).toContain(
      '<meta name="robots" content="noindex, nofollow" />',
    );
    expect(
      renderPublicDocsPage(url, { environment: "production" }),
    ).not.toContain("noindex");
  });
});
