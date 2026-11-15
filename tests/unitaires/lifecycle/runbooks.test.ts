import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALERT_KINDS,
  DEFAULT_ALERT_THRESHOLDS,
  OPERATION_RUNBOOKS,
  collectAlerts,
  evaluateAlerts,
  runbookPath,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * One runbook per alert code (plano-escala F1-20).
 *
 * The page reads "Arquivamento do WAL parado" at 3 a.m.; what to do next
 * was in somebody's head. Every rule now has a stable code, the message
 * ends with the path of its runbook, and docs/runbooks/<code>.md says what
 * the alert means, the first action, how to confirm and when to escalate.
 * A new rule without its runbook, a runbook nobody points to, or one
 * missing a section turns this red; each later wave brings the runbook with
 * the code.
 */
const RUNBOOKS = resolve(process.cwd(), "docs/runbooks");

const SECTIONS = [
  "## O que significa",
  "## Primeira ação",
  "## Como confirmar",
  "## Quando escalar",
];

const NOW = new Date("2026-11-15T12:00:00Z");
const HOUR = 3_600_000;

function healthy(): OperationalSnapshot {
  return {
    now: NOW,
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
  };
}

const CLUSTER = {
  database: {
    archiveMode: "on",
    lastArchivedAgeSec: 30,
    lastArchivedAt: new Date(NOW.getTime() - 30_000),
    lastArchiveFailedAt: null,
    archiveFailedCount: 0,
    xidAge: 1_000,
    oldestWriteXactSec: 1,
    pgWalBytes: 1_024,
  },
  redis: {
    up: true,
    maxmemoryMb: 256,
    maxmemoryPolicy: "allkeys-lru",
    evictedKeys: { delta: 0, windowSec: 900 },
  },
} satisfies Pick<OperationalSnapshot, "database" | "redis">;

/** Snapshots that, together, break every rule there is. */
function everyRuleBroken(): OperationalSnapshot[] {
  const T = DEFAULT_ALERT_THRESHOLDS;
  const old = new Date(NOW.getTime() - 30 * HOUR);

  return [
    {
      ...healthy(),
      outboxEligibleLagSec: T.outboxLagSec + 1,
      deliveryEligibleLagSec: {
        internal: T.deliveryInternalLagSec + 1,
        external: null,
      },
      webhookDueLagSec: T.webhookLagSec + 1,
      aiEligibleLagSec: T.aiLagSec + 1,
      deliveryFailures: [
        { channel: "WHATSAPP", lastError: "[whatsapp http=401 code=190] x" },
        ...Array.from({ length: T.terminalFailuresPerChannel }, () => ({
          channel: "EMAIL",
          lastError: "550 mailbox gone",
        })),
      ],
      aiProviderPausedRequests: 1,
      aiCredentialFailures: 1,
      cronJobs: [
        {
          job: "a",
          lastStatus: "RUNNING",
          lastSucceededAt: null,
          staleRunning: 1,
        },
        {
          job: "b",
          lastStatus: "FAILED",
          lastSucceededAt: old,
          staleRunning: 0,
          lastPartial: true,
          partialSince: old,
        },
        {
          job: "c",
          lastStatus: "SUCCEEDED",
          lastSucceededAt: old,
          staleRunning: 0,
        },
      ],
      partitionRunwayOk: false,
      partitionRunwayDays: 1,
      stuckWorkers: [{ replica: "api-1", worker: "outbox" }],
      connectionUsagePercent: 99,
      redisOk: false,
      proofSigning: { state: "EXPIRED", reason: null, notAfter: old },
      collectionErrors: ["worker_heartbeat: relation does not exist"],
    },
    {
      ...healthy(),
      database: {
        ...CLUSTER.database,
        archiveMode: "off",
        xidAge: T.xidAge + 1,
        oldestWriteXactSec: T.longWriteXactSec + 1,
        pgWalBytes: T.pgWalBytes + 1,
      },
      redis: {
        ...CLUSTER.redis,
        maxmemoryMb: null,
        evictedKeys: { delta: 3, windowSec: 900 },
      },
    },
    {
      ...healthy(),
      ...CLUSTER,
      database: {
        ...CLUSTER.database,
        lastArchiveFailedAt: new Date(NOW.getTime() - 1_000),
        archiveFailedCount: 1,
      },
    },
  ];
}

function runbookFiles(): string[] {
  return readdirSync(RUNBOOKS)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

describe("the alert codes", () => {
  it("are stable kebab-case names, each once", () => {
    for (const code of ALERT_KINDS) {
      expect(code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }

    expect(new Set(ALERT_KINDS).size).toBe(ALERT_KINDS.length);
  });

  it("are all raised by some rule: no code without a rule", () => {
    const raised = new Set<string>();

    for (const snapshot of everyRuleBroken()) {
      const alerts = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
        pitrExpected: true,
      });

      for (const alert of alerts) raised.add(alert.code);
    }

    expect([...raised].sort()).toEqual([...ALERT_KINDS].sort());
  });

  it("end every message with the path of the code's runbook", () => {
    for (const snapshot of everyRuleBroken()) {
      const alerts = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
        pitrExpected: true,
      });
      const reasons = evaluateAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
        pitrExpected: true,
      });

      const expected = alerts.map((alert) => {
        const link = `docs/runbooks/${alert.code}.md`;

        return `${alert.message} (runbook: ${link})`;
      });

      expect(reasons).toEqual(expected);
    }

    expect(runbookPath("redis-down")).toBe("docs/runbooks/redis-down.md");
  });
});

describe("the runbooks", () => {
  it("have one file per alert code", () => {
    const missing = ALERT_KINDS.filter(
      (code) => !existsSync(resolve(RUNBOOKS, `${code}.md`)),
    );

    expect(missing).toEqual([]);
  });

  it("have the operation runbooks no alert names yet", () => {
    for (const name of OPERATION_RUNBOOKS) {
      expect(existsSync(resolve(RUNBOOKS, `${name}.md`)), name).toBe(true);
    }
  });

  it("are all either an alert code or an operation runbook", () => {
    const known = new Set<string>([...ALERT_KINDS, ...OPERATION_RUNBOOKS]);

    expect(runbookFiles().filter((name) => !known.has(name))).toEqual([]);
  });

  it("each have the four sections, in order", () => {
    for (const name of runbookFiles()) {
      const text = readFileSync(resolve(RUNBOOKS, `${name}.md`), "utf8");
      const positions = SECTIONS.map((section) =>
        text.split("\n").indexOf(section),
      );

      expect(positions.every((position) => position >= 0), name).toBe(true);
      expect(
        [...positions].sort((a, b) => a - b),
        `${name}: sections out of order`,
      ).toEqual(positions);
    }
  });

  it("are all listed in the index", () => {
    const index = readFileSync(resolve(RUNBOOKS, "README.md"), "utf8");

    for (const name of runbookFiles()) {
      expect(index, name).toContain(`(./${name}.md)`);
    }
  });

  it("tell staging to switch archiving off when the disk is full", () => {
    const diskFull = readFileSync(resolve(RUNBOOKS, "disk-full.md"), "utf8");

    expect(diskFull).toContain("PITR_ARCHIVE");
    expect(diskFull).toMatch(/staging/i);
  });
});
