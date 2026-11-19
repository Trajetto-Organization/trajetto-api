import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HISTORY_WINDOW_SETTING } from "infra/scripts/release-step-runner";
import {
  SERVICE_BUSY_CODE,
  SERVICE_BUSY_MESSAGE,
  SERVICE_BUSY_RETRY_AFTER_SECONDS,
} from "@/shared/errors/database-error-map";
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
      jobEligibleLagSec: T.jobOverdueSec + 1,
      // A company's purge still failing past its attempts (F3-26a).
      mustFinishJobs: { failing: 1, failed: 0 },
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
      // A replica at 90% of its socket ceiling (F5-31).
      sockets: [{ replica: "api-1", connections: 4_500, cap: 5_000 }],
      // A replica whose heaps pass its container's ceiling (U-15).
      memoryBudgets: [{ replica: "api-1", totalMb: 1_174, limitMb: 1_024 }],
      // The fleet (F3-34): the due outbox above with no consumer, two
      // commits for two days, and a process of the other environment.
      processes: {
        appEnv: "production",
        live: [
          {
            replica: "api-1",
            role: "api",
            appEnv: "production",
            commit: "new",
            queues: [],
            startedAt: new Date(NOW.getTime() - HOUR),
          },
          {
            replica: "api-2",
            role: "api",
            appEnv: "production",
            commit: "old",
            queues: [],
            startedAt: old,
          },
          {
            replica: "stg-worker-1",
            role: "worker",
            appEnv: "staging",
            commit: "new",
            queues: [],
            startedAt: old,
          },
        ],
      },
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
      // Meta refused for rate today (F3-15c).
      providerThrottled: { whatsapp: 1, email: 0, push: 0 },
      // A logical restore into a new cluster without `pg_resetwal -e`
      // (F2-03): the history's txids are ahead of the cluster's counter.
      feedTxid: { newest: 5_000_000n, next: 1_000n },
      // A PITR the release step has not seen yet (U-14): the timeline moved.
      clusterEpoch: {
        stored: {
          epoch: 1,
          systemIdentifier: "7300000000000000001",
          timeline: 1,
        },
        current: { systemIdentifier: "7300000000000000001", timeline: 2 },
      },
      // And an integrator's cursor from before it, converted (F2-05).
      feedEpochConversions: 1,
      // PgBouncer (F4-36): one task silent, a client waiting 3 s for a
      // server connection, the database at 54 of its 60.
      pgbouncer: {
        status: "partial",
        read_at: NOW.toISOString(),
        error: null,
        instances: [
          {
            address: "10.0.1.7",
            status: "down",
            error: "ECONNREFUSED",
            pools: [],
            databases: [],
            stats: [],
          },
        ],
        totals: {
          instances: 2,
          instances_up: 1,
          cl_active: 40,
          cl_waiting: 3,
          maxwait_seconds: T.pgbouncerMaxWaitSec + 1,
          maxwait_pool: "trajetto/trajetto_http",
          server_connections: 54,
          server_usage_percent: 90,
          server_usage_database: "trajetto",
          paused_databases: 0,
        },
      },
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

/**
 * The history window (plano-escala F2-17, F2-18, wave 11): the owner
 * follows this runbook on a disposable copy first, then in production at
 * night, and every step has to work as it is written.
 */
describe("the history-window runbook (plano-escala F2-17, F2-18)", () => {
  const text = readFileSync(
    resolve(RUNBOOKS, "history-window.md"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const before = text.slice(
    text.indexOf("**Antes"),
    text.indexOf("**Na janela"),
  );

  // The rehearsal's copy has companies and no process of the API (D70:
  // staging at 0), so nobody announces the capability unless the block
  // does, and the release step, by the Run workflow or the
  // trajetto-api-migrate, runs on the staging Database instead of the
  // disposable one. tests/E2E/history-window-delivery-event.test.ts
  // replays the block itself.
  it("rehearses by hand on the disposable copy, the announcement and the approval in the session", () => {
    expect(before).toContain(
      "**Nunca pelo _Run workflow_ nem pela `trajetto-api-migrate`**",
    );
    expect(before).toContain("yarn prisma:migrate:deploy");
    expect(before).toContain("\\i prisma/post-deploy/00-queue-swap-ready.sql");
    expect(before).toContain(`'${HISTORY_WINDOW_SETTING}'`);
    expect(
      before.match(/"capabilities": \["history-partition-agnostic-v1"\]/g),
    ).toHaveLength(2);

    const trail = before.indexOf(
      "\\i prisma/post-deploy/30-delivery-event-window.sql",
    );

    expect(trail).toBeGreaterThan(-1);
    expect(
      before.indexOf("\\i prisma/post-deploy/31-activity-window.sql"),
    ).toBeGreaterThan(trail);
    expect(before).not.toContain("rode a etapa de novo");
  });

  // The window holds SHARE ROW EXCLUSIVE on the trail for the whole copy,
  // up to the 60 s the gate allows, while a write of the API waits only the
  // lock_timeout of its URL and then fails (U-13). The runbook and the
  // 48 h notice it dictates have to say what users get: an error to
  // repeat, not a short wait.
  it("tells what a write gets during the pause: the 503 SERVICE_BUSY after the API's lock_timeout", () => {
    const runtimeUrl = /^# DATABASE_URL=.*$/m.exec(
      readFileSync(resolve(process.cwd(), ".env.example"), "utf8"),
    )?.[0];
    const lockTimeoutMs = Number(
      /lock_timeout%3D(\d+)/.exec(runtimeUrl ?? "")?.[1],
    );

    expect(lockTimeoutMs).toBeGreaterThan(0);
    expect(text).toContain(
      `espera o lock no máximo o \`lock_timeout\` da API (${lockTimeoutMs / 1000} s`,
    );
    expect(text).toContain(`**503 \`${SERVICE_BUSY_CODE}\`**`);
    expect(text).toContain(
      `\`Retry-After\` de ${SERVICE_BUSY_RETRY_AFTER_SECONDS} s`,
    );
    expect(text).toContain(`"${SERVICE_BUSY_MESSAGE}"`);

    const notice = before.slice(before.indexOf("48 h antes"));

    expect(notice).toMatch(
      /^48 h antes: [^\n]*falham com 503 `SERVICE_BUSY`[^\n]*mesma `Idempotency-Key`/,
    );
    expect(text).not.toMatch(/gravações [^\n.]*esperam/);
  });

  // At 03:00 the owner fills the production workflow's form: image_tag is
  // required with no default, and a newer tag than production's would ship
  // a build together with the copy window, the surprise the approval
  // exists to prevent. The steps name the form's inputs as it shows them.
  it("runs the window's release step without changing the build, by the inputs production.yml has", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/production.yml"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const dispatch = workflow.slice(
      workflow.indexOf("  workflow_dispatch:"),
      workflow.indexOf("\npermissions:"),
    );
    const inputs = [...dispatch.matchAll(/^ {6}([a-z_]+):$/gm)].map(
      (match) => match[1],
    );
    const imageTag = dispatch.slice(dispatch.indexOf("      image_tag:"));

    expect(inputs).toEqual(
      expect.arrayContaining(["image_tag", "force_release"]),
    );
    expect(imageTag).toMatch(
      /^ {6}image_tag:\n(?: {8}.*\n)*? {8}required: true$/m,
    );
    expect(imageTag.split(/\n {6}[a-z_]+:\n/)[0]).not.toContain("default:");

    const during = text.slice(
      text.indexOf("**Na janela"),
      text.indexOf("**A volta"),
    );

    expect(during).toContain("**sem trocar de build**");
    expect(during).toContain("`image_tag` = a tag que a produção roda agora");
    expect(during).toContain("`force_release` marcado");
    expect(during).toContain("Nunca uma tag mais nova");
    expect(text).not.toContain("force-release");

    const variables = readFileSync(
      resolve(process.cwd(), "docs/variaveis-de-ambiente.md"),
      "utf8",
    );
    const approvalRow = variables
      .split("\n")
      .find((line) => line.startsWith("| `HISTORY_WINDOW_APPROVED`"));

    expect(approvalRow).toContain("a `image_tag` que está no ar");
    expect(approvalRow).not.toContain("force-release");
  });
});
