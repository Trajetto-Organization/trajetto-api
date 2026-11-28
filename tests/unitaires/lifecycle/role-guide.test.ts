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

  it("are right in the VPS budget too (§23)", () => {
    const pairs = memoryPairs(section(23));

    for (const [mib, bytes] of pairs) {
      expect(bytes, `${mib} MiB`).toBe(mib * MIB);
    }
  });
});

/**
 * The single VPS's budget (plano-escala X-18): deploy.md §23 sums each
 * phase's column of the ceilings tables in §19. The owner decides whether
 * a phase fits from the sums, and creates the Applications from the
 * tables: a ceiling changed in one place and not in the other makes the
 * owner create a worker the host has no room for, with no error anywhere
 * until the kernel kills a container of the production.
 */
interface Table {
  header: string[];
  rows: string[][];
}

/** The first table under `marker`, contiguous rows only. */
function firstTable(text: string, marker: string): Table {
  const start = text.indexOf(marker);

  expect(start, marker).toBeGreaterThanOrEqual(0);

  const rest = text.slice(start).split("\n");
  const first = rest.findIndex((line) => line.startsWith("|"));
  const after = rest.slice(first);
  const last = after.findIndex((line) => !line.startsWith("|"));
  const lines = last < 0 ? after : after.slice(0, last);
  const cells = (line: string) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

  return { header: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

/** "2 × 1024 (`…`), heap 768" → 2048; "igual" → the column before; "—" → 0. */
function ceiling(cell: string, before: number): number {
  if (cell === "igual") return before;
  if (cell.startsWith("—")) return 0;

  const many = cell.match(/^(\d+) × (\d+)/);

  if (many) return Number(many[1]) * Number(many[2]);

  const one = cell.match(/^(\d+)/);

  expect(one, `célula sem teto: ${cell}`).not.toBeNull();

  return Number(one![1]);
}

/** The stable sum of one phase's column: every Application but the migrate. */
function phaseSum(ceilings: Table, column: string): number {
  const first = ceilings.header.indexOf("A");
  const index = ceilings.header.indexOf(column);

  expect(first, "a coluna da fase A").toBeGreaterThan(0);
  expect(index, column).toBeGreaterThanOrEqual(first);

  return ceilings.rows
    .filter((row) => !row[0].includes("trajetto-api-migrate"))
    .reduce((sum, row) => {
      let value = 0;

      // "igual" carries the value of the phase before, cell by cell.
      for (let at = first; at <= index; at += 1) {
        value = ceiling(row[at], value);
      }

      return sum + value;
    }, 0);
}

/** "7.232" → 7232; "—" → 0; "7.456 (janela de 1 GiB)" → 7456. */
const thousands = (cell: string) =>
  cell.startsWith("—")
    ? 0
    : Number(cell.match(/^[\d.]+/)![0].replace(/\./g, ""));

describe("the single VPS's budget (deploy.md §23)", () => {
  const ceilings = () => part(roles, "\n### Tetos por Application e por fase");
  const production = () => firstTable(ceilings(), "**Produção**");
  const staging = () => firstTable(ceilings(), "**Staging**");
  const budget = () => section(23);
  const sums = () => firstTable(budget(), "A soma por fase");

  // Each row of the sums, and the columns of the ceilings it adds up.
  const PHASES: [string, string | null, string | null][] = [
    ["A ", "A", "A"],
    ["B ", "B", "B"],
    ["C ", "C", "C"],
    ["E ", "E (VPS 1 sozinha)", null],
    ["2º VPS", null, "2º VPS (onda 16 em diante)"],
  ];

  it("opens with why the first scale customer does not land on this VPS", () => {
    const opening = budget().split("\n### ")[0];

    expect(opening).toMatch(/não recebe o primeiro cliente de escala/);
    expect(opening).toMatch(/onda 22/);
  });

  it.each(PHASES)(
    "adds up phase %s from the ceilings tables",
    (label, productionColumn, stagingColumn) => {
      const row = sums().rows.find((cells) => cells[0].startsWith(label));

      expect(row, label).toBeDefined();

      const [prod, stage, host, stable] = row!.slice(1, 5).map(thousands);
      const reserve = Number(
        budget()
          .match(/\*\*Reserva do host:\*\* ([\d.]+) MiB/)![1]
          .replace(/\./g, ""),
      );

      expect(prod).toBe(
        productionColumn ? phaseSum(production(), productionColumn) : 0,
      );
      expect(stage).toBe(
        stagingColumn ? phaseSum(staging(), stagingColumn) : 0,
      );
      expect(host).toBe(reserve);
      expect(stable).toBe(prod + stage + host);
    },
  );

  it("adds the largest transient, and calls R1 met only under its ceiling", () => {
    const r1 = Number(
      budget()
        .match(/\*\*R1 \(tetos\):\*\*[\s\S]*?em até ([\d.]+) MiB/)![1]
        .replace(/\./g, ""),
    );
    const migrate = production().rows.find((row) =>
      row[0].includes("trajetto-api-migrate"),
    )!;

    expect(r1).toBe(11_500);

    for (const row of sums().rows) {
      const stable = thousands(row[4]);
      const peak = thousands(row[5]);
      const transient = row[0].startsWith("2º VPS")
        ? 1024
        : ceiling(migrate[4], 0);

      expect(peak - stable, row[0]).toBe(transient);

      if (row[6].startsWith("R1 cabe")) {
        expect(peak, row[0]).toBeLessThanOrEqual(r1);
      }
    }
  });

  it("states the staging's CPU ceilings as the tables add them", () => {
    const cpu = (column: string) => {
      const first = staging().header.indexOf("A");
      const index = staging().header.indexOf(column);

      // A cell that names no CPU keeps the one of the phase before ("512,
      // heap 224", "igual"); "—" has none, and neither has "CPU livre": the
      // staging Postgres, api and web left without a CPU Limit on
      // 26/11/2026 add nothing to the ceilings' sum.
      return staging().rows.reduce((sum, row) => {
        let value = 0;

        for (let at = first; at <= index; at += 1) {
          const found = row[at].match(/(\d+(?:,\d+)?) CPU/);

          if (found) value = Number(found[1].replace(",", "."));
          else if (row[at].startsWith("—") || /CPU livre/.test(row[at])) {
            value = 0;
          }
        }

        return sum + value;
      }, 0);
    };

    expect(budget()).toMatch(/somam 2,35 vCPU \(3,1 na B/);
    expect(cpu("A")).toBeCloseTo(2.35, 5);
    expect(cpu("B")).toBeCloseTo(3.1, 5);
  });

  it("keeps the host without swap and the earlyoom guarding the Postgres", () => {
    expect(budget()).toMatch(/\*\*sem arquivo de swap\*\*/);
    expect(budget()).toMatch(/--avoid '\^\(postgres\|/);
  });
});
