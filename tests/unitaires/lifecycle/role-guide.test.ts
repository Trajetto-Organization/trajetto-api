import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PROCESS_ROLES } from "@/shared/lifecycle/process-role";

/**
 * The owner's guide to each role's Application (plano-escala X-12):
 * docs/deploy.md §19, "Papéis da mesma imagem".
 *
 * The owner creates these Applications by hand, typing what the guide says
 * into the Dokploy panel: a role with no subsection is a role nobody knows
 * how to start, a Swarm block that is not valid JSON is refused by the
 * panel, and a health check that drifts from the image's kills tasks the
 * image considers alive (or keeps the dead ones). The memory and CPU
 * limits go in bytes and nano-CPU, where a typo is invisible: 469762048 and
 * 46976204 both look like "448 MiB" at 3 a.m. Everything here is plain fs.
 */
const read = (...path: string[]) =>
  readFileSync(resolve(process.cwd(), ...path), "utf8").replace(/\r\n/g, "\n");

const deploy = read("docs", "deploy.md");

/** The `## <n>.` section of deploy.md, up to the next `## `. */
function section(number: number): string {
  const start = deploy.indexOf(`\n## ${number}. `);
  const end = deploy.indexOf("\n## ", start + 1);

  expect(start, `deploy.md §${number}`).toBeGreaterThan(0);

  return deploy.slice(start, end < 0 ? undefined : end);
}

/** A `### ` or `#### ` part of `text`, up to the next heading of its level or above. */
function part(text: string, heading: string): string {
  const start = text.indexOf(heading);

  expect(start, heading).toBeGreaterThanOrEqual(0);

  const level = heading.match(/^\n?(#+) /)?.[1].length ?? 3;
  const next = new RegExp(`\\n#{2,${level}} `, "g");

  next.lastIndex = start + heading.length;
  const match = next.exec(text);

  return text.slice(start, match ? match.index : undefined);
}

const roles = section(19);

/** The roles the deploy action knows, in the script's own arrays. */
function deployedRoles(): string[] {
  const script = read(".github", "scripts", "deploy-roles.sh");
  const list = (name: string) =>
    script.match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"))?.[1].split(/\s+/) ??
    [];

  return [...list("BEFORE_API"), ...list("AFTER_API")].filter(Boolean);
}

const upper = (role: string) => role.toUpperCase().replace(/-/g, "_");

describe("every role has its subsection (deploy.md §19)", () => {
  it("is the section the owner looks for", () => {
    expect(deploy).toContain("\n## 19. Papéis da mesma imagem\n");
    expect(roles).not.toMatch(/só por gatilho medido/);
  });

  it.each(PROCESS_ROLES)("names how to run the role %s", (role) => {
    const text = part(roles, `\n#### \`${role}\``);

    if (role === "all") {
      expect(text).toContain("sem `PROCESS_ROLE`");
    } else {
      expect(text).toContain(`PROCESS_ROLE=${role}`);
    }
  });

  it("covers every role the deploy action deploys, with its secret, variable and tag", () => {
    const deployed = deployedRoles();

    expect(deployed).toEqual([
      "worker",
      "scheduler",
      "worker-external",
      "ingest",
      "realtime",
    ]);

    for (const role of deployed) {
      const text = part(roles, `\n#### \`${role}\``);

      expect(text, role).toContain(`DOKPLOY_${upper(role)}_APPLICATION_ID`);
      expect(text, role).toContain(`SWARM_${upper(role)}_SERVICE`);
      expect(text, role).toMatch(/ROLLOUT_ROLES_EXPECTED/);
      expect(roles, role).toContain(`\`:stable-${role}\``);
      expect(roles, role).toMatch(
        new RegExp(`^\\| ${role} +\\| criar o \`trajetto-${role}\``, "m"),
      );
    }
  });

  it("reverses each cut by changing first the Application that stays", () => {
    const worker = part(roles, "\n#### `worker`");

    expect(worker).toMatch(
      /\*\*Reversão\*\*: `PROCESS_ROLE=all` na `trajetto-api` PRIMEIRO/,
    );
    expect(part(roles, "\n#### `realtime`")).toMatch(
      /`SOCKETS_ENABLED=true` na\s+`trajetto-api` PRIMEIRO/,
    );
  });

  it("puts a Domain with a Path only on the roles that take traffic, and only with a replica", () => {
    const steps = part(roles, "\n### Criar a Application de um papel");

    expect(steps).toMatch(
      /só no `realtime` e no `ingest`, e só com _Replicas_ ≥ 1/,
    );
    expect(steps).toMatch(/_Strip Path_ \*\*desligado\*\*/);
  });
});

/** The ```json blocks of `text`, parsed. */
function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/^ *```json\n([\s\S]*?)^ *```$/gm)].map((match) =>
    JSON.parse(match[1]),
  );
}

/** `30s` → nanoseconds, as the Swarm settings want them. */
const nanoseconds = (duration: string) => {
  const seconds = duration.match(/^(\d+)s$/)?.[1];

  expect(seconds, duration).toBeDefined();

  return Number(seconds) * 1_000_000_000;
};

describe("the Swarm settings the guide pastes", () => {
  const steps = () => part(roles, "\n### Criar a Application de um papel");
  const blocks = () => jsonBlocks(steps()) as Record<string, unknown>[];

  it("are valid JSON, one block per field", () => {
    expect(blocks()).toHaveLength(4);
  });

  it("probe the liveness exactly as the image's HEALTHCHECK does", () => {
    const dockerfile = read("Dockerfile");
    const match = dockerfile.match(
      /^HEALTHCHECK((?:\s+--[\w-]+=\S+)+)\s*\\\n\s*CMD (.+)$/m,
    );

    expect(match).not.toBeNull();

    const options = Object.fromEntries(
      [...match![1].matchAll(/--([\w-]+)=(\S+)/g)].map((m) => [m[1], m[2]]),
    );
    const health = blocks().find((block) => "Test" in block)!;

    expect(health.Test).toEqual(["CMD", ...match![2].trim().split(/\s+/)]);
    expect(health.Interval).toBe(nanoseconds(options.interval));
    expect(health.Timeout).toBe(nanoseconds(options.timeout));
    expect(health.StartPeriod).toBe(nanoseconds(options["start-period"]));
    expect(String(health.Test)).toContain("/health/liveness");
  });

  it("are the API Application's own (§7.7), retries included", () => {
    const api = jsonBlocks(part(section(7), "\n### 7.7 `trajetto-api`"));

    expect(blocks()).toEqual(api);
  });

  it("roll forward with the new task first and roll back on failure", () => {
    const update = blocks().find((block) => "FailureAction" in block)!;
    const restart = blocks().find((block) => "Condition" in block)!;

    expect(update).toMatchObject({
      FailureAction: "rollback",
      Order: "start-first",
    });
    expect(restart).toMatchObject({ Condition: "any", MaxAttempts: 0 });
    expect(steps()).toContain("_Stop Grace Period_: `40000000000` (40 s)");
  });
});

const MIB = 1_048_576;
const NANO_CPU = 1_000_000_000;

/** Every "448 (`469762048`)" and "`469762048` (448 MiB)" of `text`. */
function memoryPairs(text: string): [number, number][] {
  return [
    ...[...text.matchAll(/(\d+)(?: MiB)? \(`(\d{7,})`\)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as [number, number],
    ),
    ...[...text.matchAll(/`(\d{7,})` \((\d+) MiB\)/g)].map(
      (m) => [Number(m[2]), Number(m[1])] as [number, number],
    ),
  ];
}

/** Every "0,25 CPU (`250000000`)" and "`250000000` (0,25 CPU)". */
function cpuPairs(text: string): [number, number][] {
  const number = (raw: string) => Number(raw.replace(",", "."));

  return [
    ...[...text.matchAll(/(\d+(?:,\d+)?) CPU \(`(\d+)`\)/g)].map(
      (m) => [number(m[1]), Number(m[2])] as [number, number],
    ),
    ...[...text.matchAll(/`(\d+)` \((\d+(?:,\d+)?) CPU\)/g)].map(
      (m) => [number(m[2]), Number(m[1])] as [number, number],
    ),
  ];
}

describe("the limits the owner types (bytes and nano-CPU)", () => {
  it("are each the MiB written next to them", () => {
    const pairs = memoryPairs(roles);

    expect(pairs.length).toBeGreaterThan(30);

    for (const [mib, bytes] of pairs) {
      expect(bytes, `${mib} MiB`).toBe(mib * MIB);
    }
  });

  it("are each the CPU written next to them", () => {
    const pairs = cpuPairs(roles);

    expect(pairs.length).toBeGreaterThan(10);

    for (const [cpu, nano] of pairs) {
      expect(nano, `${cpu} CPU`).toBe(Math.round(cpu * NANO_CPU));
    }
  });
});
