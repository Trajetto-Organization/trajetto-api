import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The production composes as `docker stack deploy` reads them.
 *
 * Production is a Swarm stack (Dokploy in Stack mode; Portainer before it),
 * and the Docker CLI's stack loader interpolates with its own, older rules.
 * One of them: a `-` ANYWHERE inside `${VAR...}` is taken as the "default"
 * separator before `:?` is looked at. So `${REDIS_PASSWORD:?Defina ... (openssl
 * rand -hex 32)}` never asked for the variable: it rendered the literal
 * `hex 32)` as Redis' password, `${BACKUP_R2_ACCOUNT_ID:?... runbook-restore.md)}`
 * rendered `restore.md)` as the backup's account, set or not. `docker compose`
 * (v2) reads the same text correctly, which is why nobody saw it.
 *
 * Rendered through the real CLI (`docker stack config`, client-side, no swarm
 * needed), with a sentinel per variable: every interpolation must come out as
 * the value given, and every required variable must stop the deploy when
 * missing.
 */
const ROOT = process.cwd();

const COMPOSES = [
  resolve(ROOT, "compose.production.yaml"),
  resolve(ROOT, "..", "trajetto-ui", "compose.production.yaml"),
].filter((file) => existsSync(file));

// Fields Docker parses as sizes: they need a real value, and come out normalised.
const TYPED: Record<string, string> = {
  API_MEMORY_LIMIT: "640M",
  UI_MEMORY_LIMIT: "640M",
  // trajetto-ai (ADR 0010): a size, a CPU count and a replica count.
  AI_MEMORY_LIMIT: "640M",
  AI_CPUS: "2",
  AI_REPLICAS: "1",
};

// Only what the Docker CLI needs to run; never the test process' own env.
const PASSTHROUGH = [
  "PATH",
  "Path",
  "SystemRoot",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "TEMP",
  "TMP",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
];

const hasStackConfig =
  spawnSync("docker", ["stack", "config", "--help"], { encoding: "utf8" }).status === 0;

const code = (file: string) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Every `${NAME...}` of the file (not `$${...}`, which is a literal `$`). */
function occurrences(file: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const match of code(file).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }

  return counts;
}

function required(file: string): string[] {
  return [...new Set([...code(file).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1]))];
}

const sentinel = (name: string) => `x${name.toLowerCase()}x`;

function render(file: string, values: Record<string, string>) {
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  }

  const result = spawnSync("docker", ["stack", "config", "-c", file], {
    encoding: "utf8",
    env: { ...env, ...values },
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function allSet(file: string): Record<string, string> {
  return Object.fromEntries(
    [...occurrences(file).keys()].map((name) => [name, TYPED[name] ?? sentinel(name)]),
  );
}

describe.skipIf(!hasStackConfig || COMPOSES.length === 0)(
  "the production composes under docker stack deploy",
  () => {
    it.each(COMPOSES)("render every variable exactly as given: %s", (file) => {
      const output = render(file, allSet(file));

      expect(output.status, output.stderr).toBe(0);

      const mangled = [...occurrences(file)]
        .filter(([name]) => !(name in TYPED))
        .filter(([name, count]) => output.stdout.split(sentinel(name)).length - 1 !== count)
        .map(([name, count]) => `${name}: ${count} no arquivo, ${output.stdout.split(sentinel(name)).length - 1} renderizado(s)`);

      expect(mangled).toEqual([]);
    });

    it.each(COMPOSES)("refuse to deploy without each required variable: %s", (file) => {
      const accepted = required(file).filter((name) => {
        const values = allSet(file);

        delete values[name];

        return render(file, values).status === 0;
      });

      expect(accepted).toEqual([]);
    });
  },
);

// Static, so it runs where `docker stack config` does not: the guard against
// the `-` misread must not disappear together with the CLI.
describe("the production composes, as text", () => {
  it("keep every required message free of what the stack loader misreads", () => {
    expect(COMPOSES.length).toBeGreaterThan(0);

    // `-` becomes the default separator and `}` ends the expression early.
    const unsafe = COMPOSES.flatMap((file) =>
      [...code(file).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*):\?([^}]*)\}/g)]
        .filter((match) => /[-$]/.test(match[2]))
        .map((match) => `${file}: ${match[1]}`),
    );

    expect(unsafe).toEqual([]);
  });
});
