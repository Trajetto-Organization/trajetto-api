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

/**
 * The adoption of PgBouncer (plano-escala F4-39, wave 17): the owner
 * creates the Application and switches the URLs by this runbook, first on
 * the staging of the 2nd VPS, then in production, and restarts Postgres by
 * it. What would break the staging, the production or the contractions if
 * written wrong is pinned here.
 */
describe("the pgbouncer runbook (plano-escala F4-39)", () => {
  const text = readFileSync(resolve(RUNBOOKS, "pgbouncer.md"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const section = (start: string, end?: string) =>
    text.slice(text.indexOf(start), end ? text.indexOf(end) : undefined);

  it("is an operation runbook, listed in the index", () => {
    expect(OPERATION_RUNBOOKS).toContain("pgbouncer");
  });

  it("sizes the Application as the plan's ceilings, start-first with 90 s of grace", () => {
    for (const value of [
      "`33554432`",
      "`100000000`",
      "`67108864`",
      "`250000000`",
      "`90000000000`",
      '"Order": "start-first"',
      '"FailureAction": "rollback"',
      "`PGBOUNCER_MAX_DB_CONNECTIONS=60`",
      "`DOKPLOY_PGBOUNCER_APPLICATION_ID`",
      "`SWARM_PGBOUNCER_SERVICE=trajetto-pgbouncer-staging`",
    ]) {
      expect(text, value).toContain(value);
    }

    // Production on the first VPS only once staging left it (rule R1).
    expect(text).toMatch(/depois de a staging sair da VPS única/);
  });

  it("never sends the batch nor the migration URL through PgBouncer, and keeps the admin login with the owner", () => {
    const rows = text
      .split("\n")
      .filter(
        (line) =>
          line.includes("`BATCH_DATABASE_URL`") ||
          line.includes("`MIGRATION_DATABASE_URL`"),
      )
      .filter((line) => line.startsWith("|"));

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row).toContain("direto");

    expect(text).toContain(
      "O login de administração (`pgbouncer_admin`) nunca entra no _Environment_ de nenhuma Application além da própria `trajetto-pgbouncer`",
    );
  });

  it("switches the URLs one Application at a time, with no options and the readiness on the alias", () => {
    const switching = section(
      "### Trocar as URLs",
      "### Reinício planejado do Postgres",
    );

    expect(switching).toContain("uma Application por vez");
    expect(switching).toContain("6432/trajetto?");
    expect(switching).toContain("6432/trajetto_probe?");
    expect(switching).toContain("pgbouncer=true");
    expect(switching).not.toMatch(/options=/);
    expect(switching).toContain("`READINESS_DATABASE_URL`");
    expect(switching).toContain(
      "`PGBOUNCER_STATS_HOSTS=tasks.trajetto-pgbouncer-staging`",
    );
  });

  it("restarts Postgres by PAUSE, CHECKPOINT, the Database's Deploy and RESUME, in that order", () => {
    const restart = section(
      "### Reinício planejado do Postgres",
      "### Redeploy do PgBouncer",
    );
    const order = [
      "`PAUSE trajetto;`",
      "`CHECKPOINT;`",
      "**Deploy**",
      "`RESUME trajetto;`",
    ].map((step) => restart.indexOf(step));

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(restart).toContain(
      "`psql -h 127.0.0.1 -p 6432 -U pgbouncer_admin pgbouncer`",
    );
    // What a request meets during the pause: the 503 of F4-32.
    expect(restart).toContain("503 `SERVICE_BUSY`");
  });

  it("goes back to Postgres directly one Application at a time, in reverse order", () => {
    const back = section("**Voltar ao Postgres direto**");

    expect(back).toContain("na ordem inversa da troca");
    expect(back).toContain("a `READINESS_DATABASE_URL` vazia");
  });
});

/**
 * Labels, placement and a new Swarm node (plano-escala F4-52, wave 17). The
 * labels and the constraints go on the single node first, where nothing
 * moves, so that the second node is only "add" (decision D59). Each trap
 * below was measured on a throwaway single-node Swarm (Docker 27.5.1), and
 * each one takes a service down the day the runbook stops steering around
 * it: a constraint whose label the node lacks, a label removed under a
 * running service, and MaxReplicas with no free slot for a start-first
 * rolling.
 */
describe("the swarm-multi-no runbook (plano-escala F4-52)", () => {
  const text = readFileSync(
    resolve(RUNBOOKS, "swarm-multi-no.md"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const section = (start: string, end?: string) => {
    const from = text.indexOf(start);

    expect(from, start).toBeGreaterThanOrEqual(0);

    return text.slice(from, end ? text.indexOf(end) : undefined);
  };
  /** The constraint table's row of one service, by its first cell. */
  const row = (service: string) =>
    text.split("\n").find((line) => line.startsWith(`| ${service} `)) ?? "";

  it("is an operation runbook, listed in the index", () => {
    expect(OPERATION_RUNBOOKS).toContain("swarm-multi-no");
  });

  it("labels the node in one command and checks it before any constraint", () => {
    const single = section("### No nó único", "### Um nó novo");
    const labels = single.indexOf(
      "docker node update --label-add trajetto.app=true --label-add trajetto.db=true --label-add trajetto.ai=true --label-add trajetto.edge=true <nó>",
    );
    const inspect = single.indexOf(
      "docker node inspect <nó> --format '{{json .Spec.Labels}}'",
    );
    const placement = single.indexOf("_Advanced → Swarm Settings → Placement_");

    expect(labels).toBeGreaterThan(0);
    expect(inspect).toBeGreaterThan(labels);
    expect(placement).toBeGreaterThan(inspect);
  });

  it("gives every service of both projects its constraint", () => {
    const app = '`{ "Constraints": ["node.labels.trajetto.app==true"] }`';
    const expected: Array<[string, string]> = [
      [
        "`trajetto-postgres` (Database)",
        '`{ "Constraints": ["node.labels.trajetto.db==true", "node.hostname==<nó do volume>"] }`',
      ],
      [
        "`trajetto-redis` (Database)",
        '`{ "Constraints": ["node.hostname==<nó do volume>"] }`',
      ],
      [
        "`trajetto-pgbouncer` ×1",
        '`{ "Constraints": ["node.labels.trajetto.db==true"] }`',
      ],
      [
        "`trajetto-pgbouncer` ×2 (onda 23)",
        '`{ "Constraints": ["node.labels.trajetto.db==true"], "MaxReplicas": 1 }`',
      ],
      [
        "`trajetto-ai`",
        '`{ "Constraints": ["node.labels.trajetto.ai==true"] }`',
      ],
      [
        "`trajetto-api`",
        '`{ "Constraints": ["node.labels.trajetto.app==true"], "MaxReplicas": 4 }`',
      ],
      ["`trajetto-worker`", app],
      ["`trajetto-scheduler`", app],
      ["`trajetto-worker-external`", app],
      ["`trajetto-realtime`", app],
      ["`trajetto-ingest`", app],
      ["`trajetto-api-migrate`", app],
      ["`trajetto-ui` (projeto `trajetto-ui`)", app],
    ];

    for (const [service, placement] of expected) {
      expect(row(service), service).toContain(placement);
    }

    // Two PgBouncers on two nodes only roll stop-first: start-first with
    // MaxReplicas 1 leaves the new task Pending forever (measured).
    expect(row("`trajetto-pgbouncer` ×2 (onda 23)")).toContain(
      '`"Order": "stop-first"`',
    );
    expect(row("`trajetto-pgbouncer` ×1").split("|")[2]).not.toContain(
      "MaxReplicas",
    );
    // Dokploy's default for a service with a volume is what goes away.
    expect(text).not.toMatch(/\|[^|\n]*`\{[^`]*node\.role==manager/);
  });

  it("keeps the traps it measured in sight", () => {
    for (const fact of [
      "Docker 27.5.1",
      "no suitable node",
      "max replicas per node limit exceed",
      "assigned node no longer meets constraints",
      "**Nunca tire um label** de um nó enquanto um serviço que o exige roda nele",
      "4 × (nós `trajetto.app`) − 1",
      "`PGBOUNCER_MAX_DB_CONNECTIONS`",
      "`PROOF_SIGNING_PFX_BASE64`",
      "`ROLLOUT_VERIFY=http`",
      "`SWARM_NODE_HOSTNAME={{.Node.Hostname}}`",
    ]) {
      expect(text, fact).toContain(fact);
    }
  });

  it("puts the Databases' placement in the Postgres window, never outside it", () => {
    const single = section("### No nó único", "### Um nó novo");

    expect(single).toContain("`PAUSE trajetto;`");
    expect(single).toContain("`CHECKPOINT;`");
    expect(single).toContain("`RESUME trajetto;`");
    expect(single).toContain("nunca fora dela");
  });

  it("opens the Swarm's ports on the private network only, with ESP for an encrypted overlay", () => {
    const node = section("### Um nó novo", "## Como confirmar");

    for (const port of ["2377/tcp", "7946/tcp", "7946/udp", "4789/udp"]) {
      expect(node).toContain(port);
    }

    expect(node).toContain("**protocolo IP 50 (ESP)**");
    expect(node).toContain("**As portas do Swarm só na rede privada**");
    expect(node).toContain("_Cluster → Add Node_");
    expect(node).toContain("**worker**");
    // The GHCR pull on a worker node, staging first, before any other label.
    expect(node).toMatch(/\*\*O teste de pull do GHCR\*\*, na staging/);
    expect(node.indexOf("**O teste de pull do GHCR**")).toBeLessThan(
      node.indexOf("--label-add trajetto.db=true"),
    );
  });

  it("accepts the single node by the same docker service ps before and after", () => {
    const confirm = section("## Como confirmar", "## Quando escalar");

    expect(text).toContain("> ~/placement-antes.txt");
    expect(text).toContain("> ~/placement-depois.txt");
    expect(confirm).toContain(
      "diff ~/placement-antes.txt ~/placement-depois.txt",
    );
  });

  it("names services by their App Name markers and carries no address or secret", () => {
    for (const match of text.matchAll(
      /docker service (?:inspect|ps) ([^\s`]+)/g,
    )) {
      expect(match[1]).toMatch(
        /^(?:"\$s"|trajetto-[a-z-]+-(?:staging|production))$/,
      );
    }

    expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(text).not.toMatch(/SWMTKN-/);
    expect(text).not.toMatch(
      /[\w.%+-]+@(?!example\.com)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i,
    );
  });

  it("is where the Dokploy guide and the PgBouncer runbook send the placement", () => {
    const deploy = readFileSync(
      resolve(process.cwd(), "docs/deploy.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const pgbouncer = readFileSync(resolve(RUNBOOKS, "pgbouncer.md"), "utf8");

    expect(deploy).toContain("(./runbooks/swarm-multi-no.md");
    expect(deploy).not.toMatch(/_Placement_: vazio até a\s+onda 17/);
    expect(pgbouncer).toContain("(./swarm-multi-no.md");
  });
});
