import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envShape } from "@/schemas/env-schema/defined-env";

/**
 * `.env.example` is the only versioned list of what this API can be given.
 *
 * It drifted both ways: OSRM_URL stayed in it (and in the schema) long after
 * the last reader was deleted, while ACTIVITY_RETENTION_DAYS — read by the
 * nightly purge and passed by the production compose — was never in it. An
 * operator filling a new stack (staging, Dokploy) from the example got a dead
 * knob and missed a live one.
 *
 * Commented lines count as documented: optional variables are listed as
 * `# NAME=value` on purpose.
 */
const ROOT = process.cwd();
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const NAME = /[A-Z][A-Z0-9_]*/.source;

function documented(): Set<string> {
  const names = read(".env.example")
    .split(/\r?\n/)
    .map((line) => line.match(new RegExp(`^#?\\s*(${NAME})=`))?.[1])
    .filter((name): name is string => !!name);

  return new Set(names);
}

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path, pattern);

    return pattern.test(entry.name) ? [path] : [];
  });
}

/** `process.env.NAME` in the code that runs in the API's container. */
function readByCode(): Set<string> {
  const names = new Set<string>();

  for (const file of [...files("src", /\.ts$/), ...files("infra", /\.ts$/)]) {
    for (const match of read(file).matchAll(new RegExp(`process\\.env\\.(${NAME})`, "g"))) {
      names.add(match[1]);
    }
  }

  for (const match of read("prisma/schema.prisma").matchAll(new RegExp(`env\\("(${NAME})"\\)`, "g"))) {
    names.add(match[1]);
  }

  return names;
}

/** `${NAME}` interpolated by a compose file, comments left out. */
function interpolatedBy(compose: string): Set<string> {
  const code = read(compose)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  return new Set(
    [...code.matchAll(new RegExp(`\\$\\{(${NAME})(?::?[-?][^}]*)?\\}`, "g"))].map(
      (match) => match[1],
    ),
  );
}

/** Names a shell script of the image or the backup sidecar reads. */
function readByScripts(): Set<string> {
  const names = new Set<string>();

  for (const file of [...files("infra/scripts", /\.sh$/), ...files("infra/backup", /\.sh$/)]) {
    for (const match of read(file).matchAll(new RegExp(`\\$\\{?(${NAME})`, "g"))) {
      names.add(match[1]);
    }
  }

  return names;
}

describe(".env.example", () => {
  const example = documented();

  it("lists every variable the schema accepts", () => {
    const missing = Object.keys(envShape()).filter((name) => !example.has(name));

    expect(missing).toEqual([]);
  });

  it("lists every variable the code reads straight from process.env", () => {
    const missing = [...readByCode()].filter((name) => !example.has(name));

    expect(missing).toEqual([]);
  });

  it.each(["compose.production.yaml", "compose.development.yaml"])(
    "lists every variable %s interpolates",
    (compose) => {
      const missing = [...interpolatedBy(compose)].filter((name) => !example.has(name));

      expect(missing).toEqual([]);
    },
  );

  it("lists nothing that nobody reads", () => {
    const readers = new Set([
      ...Object.keys(envShape()),
      ...readByCode(),
      ...interpolatedBy("compose.production.yaml"),
      ...interpolatedBy("compose.development.yaml"),
      ...readByScripts(),
    ]);

    const dead = [...example].filter((name) => !readers.has(name));

    expect(dead).toEqual([]);
  });
});
