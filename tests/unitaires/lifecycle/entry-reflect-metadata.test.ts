import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * tsyringe throws "tsyringe requires a reflect polyfill" the moment it is
 * loaded without reflect-metadata. The production bundle gets the polyfill
 * from tsup's banner, but `yarn start:dev` / `yarn dev:server` run the entry
 * through tsx, where only the import order counts: src/server.ts imported
 * tsyringe on line 1, before ./http (which loads the polyfill), and the dev
 * server died at boot.
 */
const firstImport = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8")
    .split(/\r?\n/)
    .find((line) => /^\s*import\b/.test(line));

describe("the process entry points", () => {
  it.each(["src/server.ts"])("%s loads reflect-metadata before anything else", (file) => {
    expect(firstImport(file)).toBe('import "reflect-metadata";');
  });
});
