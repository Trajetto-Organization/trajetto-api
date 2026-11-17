import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
      // The 7 days alone are the whole month's gate (U-12).
      volume: { last24h: 0, last7d: T.approvedGateMonthlyDeliveries },
      // Past 70% of the provider's day (F2-32).
      geocodingQuota: { usedToday: 17_501, dailyQuota: 25_000 },
      // A logical restore into a new cluster without `pg_resetwal -e`
      // (F2-03): the history's txids are ahead of the cluster's counter.
      feedTxid: { newest: 5_000_000n, next: 1_000n },
    },
    {
      ...healthy(),
      // The registry's tables (F2-09): one under the 5-day lookahead, one
      // with a partition never dropped.
      partitions: [
        {
          table: "driver_position",
          lookaheadDays: 4,
          runwayOk: true,
          lookaheadOk: false,
          stuck: [],
        },
        {
          table: "delivery_event_part",
          lookaheadDays: 40,
          runwayOk: true,
          lookaheadOk: true,
          stuck: ["delivery_event_part_202501"],
        },
      ],
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

      expect(
        positions.every((position) => position >= 0),
        name,
      ).toBe(true);
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

/**
 * The two runbooks that move servers (plano-escala F1-24): the staging to a
 * Remote Server, and production to its own servers. Recreating the
 * Applications changes every App Name and applicationId at once, and one
 * name forgotten means a deploy that goes to the old server or a check that
 * never converges. So the recreation path's list is closed against the
 * names the deploy workflows of the API and of the web actually read, plus
 * the ones the plan adds with later waves.
 */
describe("the server runbooks (plano-escala F1-24)", () => {
  const read = (name: string) =>
    readFileSync(resolve(RUNBOOKS, `${name}.md`), "utf8").replace(
      /\r\n/g,
      "\n",
    );
  const staging = read("staging-remote-server");
  const production = read("producao-servidores-proprios");

  /** The secrets and vars a repository's deploy reads that name a server's objects. */
  function serverNames(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;

      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) walk(path);
        else if (/\.ya?ml$/.test(entry.name)) files.push(path);
      }
    };

    walk(join(root, ".github", "workflows"));
    walk(join(root, ".github", "actions"));

    const names = files.flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /\b(?:secrets|vars)\.([A-Z0-9_]+)\b/g,
        ),
      ].map((match) => match[1]),
    );

    return [
      ...new Set(
        names.filter((name) =>
          /^(?:DOKPLOY_\w+_APPLICATION_ID|SWARM_\w+_SERVICE|ROLLOUT_\w+|DEPLOY_SSH_\w+|DEPLOY_VERIFY_SSH_KEY)$/.test(
            name,
          ),
        ),
      ),
    ];
  }

  it("are operation runbooks", () => {
    expect(OPERATION_RUNBOOKS).toContain("staging-remote-server");
    expect(OPERATION_RUNBOOKS).toContain("producao-servidores-proprios");
  });

  it("give both paths: the v0.31.x transfer and the recreation", () => {
    expect(staging).toContain("#5396");

    for (const text of [staging, production]) {
      expect(text).toContain("v0.31.x");
      expect(text).toMatch(/\*\*\(a\) Transferência\*\*/);
      expect(text).toMatch(/\*\*\(b\) Recriação\*\*/);
    }

    expect(staging).toContain("### Caminho (a): transferência");
    expect(staging).toContain("### Caminho (b): recriação");
    expect(staging).toMatch(/recebe[mn]? \*\*só o seed\*\*/);
  });

  it("close the recreation list on every name the deploys read, and the plan's", () => {
    const start = staging.indexOf("### Caminho (b): recriação");
    const end = staging.indexOf("### Nos dois caminhos, no fim");
    const recreation = staging.slice(start, end);
    const api = serverNames(process.cwd());
    const web = serverNames(resolve(process.cwd(), "..", "trajetto-ui"));
    const names = [
      ...api,
      ...web,
      // Read by later waves' Applications and checks (plano-escala 3.4,
      // 3.5, 3.7 and U-11): in the list before the first one exists.
      "DOKPLOY_WORKER_APPLICATION_ID",
      "DOKPLOY_SCHEDULER_APPLICATION_ID",
      "DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID",
      "DOKPLOY_REALTIME_APPLICATION_ID",
      "DOKPLOY_INGEST_APPLICATION_ID",
      "DOKPLOY_PGBOUNCER_APPLICATION_ID",
      "SWARM_WORKER_SERVICE",
      "SWARM_SCHEDULER_SERVICE",
      "SWARM_WORKER_EXTERNAL_SERVICE",
      "SWARM_REALTIME_SERVICE",
      "SWARM_INGEST_SERVICE",
      "SWARM_PGBOUNCER_SERVICE",
      "ROLLOUT_ROLES_EXPECTED",
      "RELEASE_SERIALIZE_WITH_APPLICATION_ID",
      "HTTP_REQUEST",
      "PGBOUNCER_PRIMARY_HOST",
      "PGBOUNCER_STATS_HOSTS",
      "DATABASE_URL",
      "REDIS_URL",
      "AI_LOCAL_URL",
    ];

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(api).toEqual(
      expect.arrayContaining([
        "DOKPLOY_API_APPLICATION_ID",
        "SWARM_API_SERVICE",
        "ROLLOUT_VERIFY",
      ]),
    );
    expect(
      [...new Set(names)].filter((name) => !recreation.includes(`\`${name}\``)),
    ).toEqual([]);
    // The forced command lives on the host, not in GitHub.
    expect(recreation).toContain(
      'command="/usr/local/bin/trajetto-verify-rollout"',
    );
  });

  it("open the Swarm's ports on the private network only, with ESP for an encrypted overlay", () => {
    for (const port of ["2377/tcp", "7946/tcp", "7946/udp", "4789/udp"]) {
      expect(production).toContain(port);
    }

    expect(production).toContain("**protocolo IP 50 (ESP)**");
    expect(production).toContain("**As portas do Swarm só na rede privada**");
    expect(production).toContain("_Cluster → Add Node_");
    expect(production).toContain("node.labels.trajetto.db==true");
  });

  it("move the database by a restored standby and a promote, never two primaries", () => {
    const stop = production.indexOf("**Stop** no Database antigo");
    const promote = production.indexOf("SELECT pg_promote()");

    expect(production).toContain("--type=standby --delta restore");
    expect(stop).toBeGreaterThan(0);
    expect(promote).toBeGreaterThan(stop);
    expect(production).toContain("**Nunca dois primários na mesma stanza**");
    expect(production).toContain("--repo=2 check");
  });

  it("keep the 24 h go/no-go and the old production stopped for 7 days", () => {
    expect(production).toContain("**Go/no-go de 24 h**");
    expect(production).toContain("parada 7 dias");
  });

  it("name services by their App Name markers and carry no secret", () => {
    for (const text of [staging, production]) {
      for (const match of text.matchAll(/service\.name=([^\s)`"]+)/g)) {
        expect(match[1]).toMatch(/^trajetto-[a-z-]+-(?:staging|production)$/);
      }

      for (const match of text.matchAll(
        /docker service (?:inspect|ps) ([^\s`]+)/g,
      )) {
        expect(match[1]).toMatch(/^trajetto-[a-z-]+-(?:staging|production)$/);
      }

      // No address, key or account of a real host.
      expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      expect(text).not.toMatch(/ssh-ed25519 [A-Za-z0-9+/]{20,}/);
      expect(text).not.toMatch(/sha256:[0-9a-f]{64}/);
      expect(text).not.toMatch(
        /[\w.%+-]+@(?!example\.com)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i,
      );
    }
  });
});
