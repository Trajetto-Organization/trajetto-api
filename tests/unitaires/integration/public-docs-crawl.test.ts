import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * What a search engine may crawl on the API host.
 *
 * Production's console stopped saying noindex, but the host still served
 * only Cloudflare's managed robots.txt (`Allow: /` for every crawler) and no
 * sitemap: the console could be found only through links, and every JSON
 * endpoint was open to crawling. The host now answers its own robots.txt,
 * which keeps everything but the console out, and a sitemap with the
 * console, in production only.
 *
 * No database: both are static.
 */
let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const API = "https://api.exemplo.com.br";

/** The block Cloudflare's managed robots.txt prepends to the origin's file. */
const CLOUDFLARE_MANAGED_BLOCK = `# BEGIN Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: GPTBot
Disallow: /

# END Cloudflare Managed Content
`;

/**
 * Whether `path` may be crawled by a generic crawler, by RFC 9309 as Google
 * applies it: every group for `*` merges, the longest matching rule wins, and
 * on a tie the allowing rule does.
 */
function crawlable(robots: string, path: string): boolean {
  const rules: { allow: boolean; pattern: string }[] = [];
  let agents: string[] = [];
  let inRules = false;

  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);

    if (!match) continue;
    const [, field, value] = match;
    const key = field.toLowerCase();

    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (agents.includes("*") && value) {
        rules.push({ allow: key === "allow", pattern: value });
      }
    }
  }

  const matches = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, (c) => (c === "$" ? c : `\\${c}`))
          .replace(/\*/g, ".*"),
    ).test(path);

  const winner = rules
    .filter((rule) => matches(rule.pattern))
    .sort(
      (a, b) =>
        b.pattern.length - a.pattern.length ||
        Number(b.allow) - Number(a.allow),
    )[0];

  return winner ? winner.allow : true;
}

describe("the API host's robots.txt", () => {
  it("in production, opens the console and its document and nothing else", async () => {
    const { renderApiRobotsTxt } = await import(
      "@/shared/integration/public-docs"
    );

    const robots = renderApiRobotsTxt({
      environment: "production",
      serverUrl: API,
    });
    const served = CLOUDFLARE_MANAGED_BLOCK + robots;

    expect(robots).toContain(`Sitemap: ${API}/sitemap.xml`);
    expect(crawlable(served, "/integration/docs")).toBe(true);
    expect(crawlable(served, "/integration/docs/openapi.json")).toBe(true);
    for (const path of [
      "/integration/v1/deliveries",
      "/integration/v1/catalogue",
      "/health",
      "/sessions",
      "/public/track/abc",
      "/docs",
    ]) {
      expect(crawlable(served, path), path).toBe(false);
    }
  });

  it("would have lost to Cloudflare's block with a bare Disallow: /", () => {
    const naive = `User-agent: *\nDisallow: /\n`;

    expect(crawlable(CLOUDFLARE_MANAGED_BLOCK + naive, "/health")).toBe(true);
  });

  it("closes a staging host entirely and advertises no sitemap", async () => {
    const { renderApiRobotsTxt } = await import(
      "@/shared/integration/public-docs"
    );

    const robots = renderApiRobotsTxt({
      environment: "staging",
      serverUrl: API,
    });
    const served = CLOUDFLARE_MANAGED_BLOCK + robots;

    expect(robots).not.toContain("Sitemap:");
    expect(crawlable(served, "/integration/docs")).toBe(false);
    expect(crawlable(served, "/health")).toBe(false);
  });

  it("is served as plain text", async () => {
    const response = await app.inject({ method: "GET", url: "/robots.txt" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // The test run is not production: the host is closed.
    expect(response.body).toBe("User-agent: *\nDisallow: /*\n");
  });
});

describe("the API host's sitemap", () => {
  it("lists production's console on the API's own origin", async () => {
    const { renderApiSitemapXml } = await import(
      "@/shared/integration/public-docs"
    );

    const xml = renderApiSitemapXml({
      environment: "production",
      serverUrl: API,
    });

    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml?.match(/<loc>([^<]+)<\/loc>/g)).toEqual([
      `<loc>${API}/integration/docs</loc>`,
    ]);
    expect(xml).not.toContain("<lastmod>");
  });

  it("does not exist on staging, nor without the API's public URL", async () => {
    const { renderApiSitemapXml } = await import(
      "@/shared/integration/public-docs"
    );

    expect(
      renderApiSitemapXml({ environment: "staging", serverUrl: API }),
    ).toBeNull();
    expect(renderApiSitemapXml({ environment: "production" })).toBeNull();

    const response = await app.inject({ method: "GET", url: "/sitemap.xml" });

    expect(response.statusCode).toBe(404);
  });
});
