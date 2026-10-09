import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every production container rotates its own log (OBS-14).
 *
 * The stack used Docker's default json-file driver with no options, which
 * never rotates: unless the host's daemon.json says otherwise — and that file
 * is not versioned anywhere — each container's log grows until the disk is
 * full. At the measured ~195 requests a second per replica, two lines per
 * request is gigabytes a day, and Postgres keeps its data on a local volume
 * of the same node: a full disk takes the database down with it.
 *
 * The compose file is the only place the rotation can be decided with the
 * deploy, so the test reads it. Explicit per service rather than through a
 * YAML anchor, so each block is what the file says and not what a parser
 * makes of it.
 */
const compose = readFileSync(
  resolve(process.cwd(), "compose.production.yaml"),
  "utf8",
);

function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `serviço ${name} não encontrado`).toBeGreaterThan(-1);

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\r?\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe.each(["trajetto-database", "trajetto-redis", "api"])(
  "the %s container's log",
  (name) => {
    const block = service(name);

    it("uses the json-file driver, explicitly", () => {
      expect(block).toMatch(/\n    logging:\r?\n      driver: json-file\r?\n/);
    });

    it("rotates by size, keeping a bounded number of files", () => {
      expect(block).toMatch(/\n        max-size: "\d+m"\r?\n/);
      expect(block).toMatch(/\n        max-file: "\d+"\r?\n/);
    });
  },
);

describe("the API's log level", () => {
  it("is set from the deploy, with info when nothing is set", () => {
    expect(service("api")).toContain("LOG_LEVEL: ${LOG_LEVEL:-info}");
  });
});
