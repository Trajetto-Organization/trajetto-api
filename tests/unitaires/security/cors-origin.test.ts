import { describe, expect, it } from "vitest";

import { isOriginAllowed } from "@/config/cors-origin";

const PRODUCTION = { allowedOrigin: "https://app.trajetto.com", isProduction: true };
const DEVELOPMENT = { allowedOrigin: "http://localhost:3000", isProduction: false };

describe("CORS origin — always allowed", () => {
  /**
   * The browser only sends Origin on cross-origin requests. curl, the mobile
   * app and server-to-server calls send none, and refusing those would break
   * every non-browser client for no security gain — CORS protects browsers.
   */
  it("accepts a request with no Origin at all", () => {
    expect(isOriginAllowed(undefined, PRODUCTION)).toBe(true);
    expect(isOriginAllowed(undefined, DEVELOPMENT)).toBe(true);
    expect(isOriginAllowed("", PRODUCTION)).toBe(true);
  });

  it("accepts the configured front-end origin in both environments", () => {
    expect(isOriginAllowed("https://app.trajetto.com", PRODUCTION)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", DEVELOPMENT)).toBe(true);
  });
});

describe("CORS origin — development loopback", () => {
  /**
   * The reason this rule exists: another project holding port 3000 pushes
   * Next to 3001, and a pinned origin makes every browser call fail with
   * "Failed to fetch" while the server log stays empty.
   */
  it("accepts any loopback port outside production", () => {
    for (const origin of [
      "http://localhost:3001",
      "http://localhost:3002",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "https://localhost:3000",
      "http://localhost",
    ]) {
      expect(isOriginAllowed(origin, DEVELOPMENT)).toBe(true);
    }
  });

  it("refuses the same loopback origins in production", () => {
    for (const origin of [
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://localhost",
    ]) {
      expect(isOriginAllowed(origin, PRODUCTION)).toBe(false);
    }
  });
});

describe("CORS origin — refusals", () => {
  it("refuses a foreign site in every environment", () => {
    for (const context of [PRODUCTION, DEVELOPMENT]) {
      expect(isOriginAllowed("https://evil.com", context)).toBe(false);
      expect(isOriginAllowed("http://trajetto.com.evil.com", context)).toBe(
        false,
      );
    }
  });

  /**
   * The loopback pattern is anchored on purpose. A hostname that merely
   * contains "localhost" belongs to whoever registered it.
   */
  it("refuses hostnames that only look like loopback", () => {
    for (const origin of [
      "http://localhost.evil.com",
      "http://evil.com/localhost",
      "http://notlocalhost:3000",
      "http://127.0.0.1.evil.com",
      "http://localhost:3000.evil.com",
      "http://127.0.0.10",
    ]) {
      expect(isOriginAllowed(origin, DEVELOPMENT)).toBe(false);
    }
  });

  /**
   * Only http(s). A page loaded from a file:// or a custom scheme must not
   * be able to read tenant data.
   */
  it("refuses non-http schemes on loopback", () => {
    expect(isOriginAllowed("file://localhost", DEVELOPMENT)).toBe(false);
    expect(isOriginAllowed("ftp://localhost:3000", DEVELOPMENT)).toBe(false);
    expect(isOriginAllowed("null", DEVELOPMENT)).toBe(false);
  });
});
