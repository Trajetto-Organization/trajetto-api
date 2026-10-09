import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The edge settings that no Docker label can express, versioned.
 *
 * Plain HTTP on :80 and the TLS floor lived only in the host's Traefik
 * configuration, outside every repository: nothing said :80 redirects, and
 * nothing kept TLS 1.0/1.1 out. infra/traefik holds the reference the host is
 * configured from; this keeps its two load-bearing keys from quietly going.
 */
const read = (...path: string[]) =>
  readFileSync(resolve(process.cwd(), "infra", "traefik", ...path), "utf8");

describe("the Traefik reference", () => {
  it("redirects every plain-HTTP request to HTTPS, permanently", () => {
    const staticConfig = read("traefik.reference.yaml");

    expect(staticConfig).toMatch(
      /web:\s*\r?\n\s*address: ":80"\s*\r?\n\s*http:\s*\r?\n\s*redirections:\s*\r?\n\s*entryPoint:\s*\r?\n\s*to: websecure\s*\r?\n\s*scheme: https\s*\r?\n\s*permanent: true/,
    );
  });

  it("loads the dynamic folder where the TLS options live", () => {
    expect(read("traefik.reference.yaml")).toMatch(
      /providers:\s*\r?\n\s*file:\s*\r?\n(?:\s*#.*\r?\n)*\s*directory: /,
    );
  });

  it("refuses anything below TLS 1.2 by default", () => {
    expect(read("dynamic", "tls.yaml")).toMatch(
      /tls:\s*\r?\n\s*options:\s*\r?\n\s*default:\s*\r?\n\s*minVersion: VersionTLS1[23]\b/,
    );
  });
});
