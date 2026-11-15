import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  alertThresholdsFromEnv,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * OBS-03: nothing alerted. The metrics could only be read by a MASTER with a
 * 15-minute token, on demand, and an expired Meta token or a stuck worker was
 * found when a customer complained. The ops heartbeat now evaluates these
 * rules every minute and pushes the verdict to an external dead man's switch.
 *
 * The rules are what decides between a page and silence, so each one is
 * pinned here — including the cases that must NOT page: a delivery or a
 * webhook waiting out its backoff is the system working.
 */
const NOW = new Date("2026-09-24T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function healthy(): OperationalSnapshot {
  return {
    now: NOW,
    outboxEligibleLagSec: 2,
    deliveryEligibleLagSec: { internal: 1, external: 5 },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [
      {
        job: "cleanup-notification-pipeline",
        lastStatus: "SUCCEEDED",
        lastSucceededAt: new Date(NOW.getTime() - 10 * HOUR),
        staleRunning: 0,
      },
    ],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 12,
    redisOk: true,
    collectionErrors: [],
  };
}

describe("a healthy system", () => {
  it("raises nothing", () => {
    expect(evaluateAlerts(healthy())).toEqual([]);
  });
});

describe("a queue nobody is draining", () => {
  it("pages on an outbox event due for longer than the threshold", () => {
    const reasons = evaluateAlerts({ ...healthy(), outboxEligibleLagSec: 400 });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/outbox/i);
    expect(reasons[0]).toContain("400");
  });

  it("gives each delivery lane its own threshold", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        deliveryEligibleLagSec: {
          internal: DEFAULT_ALERT_THRESHOLDS.deliveryInternalLagSec + 1,
          external: 5,
        },
      }),
    ).toHaveLength(1);

    // Ten minutes is inside the external lane's patience.
    expect(
      evaluateAlerts({
        ...healthy(),
        deliveryEligibleLagSec: { internal: 1, external: 600 },
      }),
    ).toEqual([]);
  });

  it("stays silent while every delivery waits out a 30-minute backoff", () => {
    // Eligible lag is null: nothing is due. created_at-based age would say
    // "stuck for 30 minutes" and page on every provider hiccup.
    expect(
      evaluateAlerts({
        ...healthy(),
        deliveryEligibleLagSec: { internal: null, external: null },
      }),
    ).toEqual([]);
  });

  it("stays silent while webhooks wait out a customer's six-hour backoff", () => {
    expect(evaluateAlerts({ ...healthy(), webhookDueLagSec: null })).toEqual(
      [],
    );
  });

  it("pages when due webhooks are not being taken", () => {
    const reasons = evaluateAlerts({ ...healthy(), webhookDueLagSec: 3_600 });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/webhook/i);
  });

  it("pages when AI analyses due are not being taken", () => {
    expect(
      evaluateAlerts({ ...healthy(), aiEligibleLagSec: 1_200 }),
    ).toHaveLength(1);
  });
});

describe("a broken credential", () => {
  it("pages on the FIRST WhatsApp failure with an expired token", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      deliveryFailures: [
        {
          channel: "WHATSAPP",
          lastError: "[whatsapp http=401 code=190] Session has expired",
        },
      ],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/WHATSAPP/);
    expect(reasons[0]).toContain("code=190");
  });

  it("pages on an SMTP authentication failure", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      deliveryFailures: [
        {
          channel: "EMAIL",
          lastError: "[email smtp=EAUTH reply=535] Invalid login",
        },
      ],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/EMAIL/);
  });

  it("does not page on a single failure that is not a credential", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        deliveryFailures: [
          {
            channel: "WHATSAPP",
            lastError: "[whatsapp http=400 code=131026] Message undeliverable",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("pages on a burst of terminal failures on one channel", () => {
    const burst = Array.from(
      { length: DEFAULT_ALERT_THRESHOLDS.terminalFailuresPerChannel },
      () => ({
        channel: "WHATSAPP",
        lastError: "[whatsapp http=400 code=131026] Message undeliverable",
      }),
    );

    const reasons = evaluateAlerts({ ...healthy(), deliveryFailures: burst });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/WHATSAPP/);
  });

  it("pages on an AI provider refusing our key", () => {
    expect(
      evaluateAlerts({ ...healthy(), aiCredentialFailures: 1 }),
    ).toHaveLength(1);
  });
});

describe("the machinery behind the queues", () => {
  it("pages on a cron job with no success in 26 hours", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      cronJobs: [
        {
          job: "driver-position-partitions",
          lastStatus: "FAILED",
          lastSucceededAt: new Date(NOW.getTime() - 27 * HOUR),
          staleRunning: 0,
        },
      ],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("driver-position-partitions");
  });

  it("pages on a job that ran and never succeeded", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      cronJobs: [
        {
          job: "novo-job",
          lastStatus: "FAILED",
          lastSucceededAt: null,
          staleRunning: 0,
        },
      ],
    });

    expect(reasons).toHaveLength(1);

    // Its only run may have been a minute ago: the reason must not claim
    // "more than 26 h", which sends the operator after the wrong problem.
    expect(reasons[0]).not.toMatch(/26\s*h/);
    expect(reasons[0]).toMatch(/nenhuma execução bem-sucedida/);
  });

  it("does not page on a job registered minutes ago that has not fired yet", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        cronJobs: [
          {
            job: "novo-job",
            lastStatus: null,
            lastSucceededAt: null,
            staleRunning: 0,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("pages on a run whose lease expired", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        cronJobs: [
          {
            job: "cleanup-user-history",
            lastStatus: "RUNNING",
            lastSucceededAt: new Date(NOW.getTime() - 2 * HOUR),
            staleRunning: 1,
          },
        ],
      }),
    ).toHaveLength(1);
  });

  /**
   * A partial purge (F1-17) did work and left some: the catch-up sweep
   * retries it in the morning window, and the next night after that. The
   * first partial is not a page, even when the last success is older than
   * 26 h (a quiet night, then a big one); 26 h of nothing but partials is,
   * because then the purge is losing to the inflow.
   */
  it("does not page on the first partial run, even after an old success", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        cronJobs: [
          {
            job: "cleanup-notification-pipeline",
            lastStatus: "FAILED",
            lastSucceededAt: new Date(NOW.getTime() - 30 * HOUR),
            staleRunning: 0,
            lastPartial: true,
            partialSince: new Date(NOW.getTime() - 3 * HOUR),
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not page on a new job whose only runs were partial", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        cronJobs: [
          {
            job: "cleanup-expired-refresh-tokens",
            lastStatus: "FAILED",
            lastSucceededAt: null,
            staleRunning: 0,
            lastPartial: true,
            partialSince: new Date(NOW.getTime() - 25 * HOUR),
          },
        ],
      }),
    ).toEqual([]);
  });

  it("pages after 26 hours of nothing but partial runs", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      cronJobs: [
        {
          job: "cleanup-notification-pipeline",
          lastStatus: "FAILED",
          lastSucceededAt: new Date(NOW.getTime() - 50 * HOUR),
          staleRunning: 0,
          lastPartial: true,
          partialSince: new Date(NOW.getTime() - 26 * HOUR - 60_000),
        },
      ],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/só execuções parciais há mais de 26h/);
  });

  it("pages when the driver_position partitions are running out", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      partitionRunwayOk: false,
      partitionRunwayDays: 2,
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("2");
  });

  it("pages on a stuck worker", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      stuckWorkers: [
        { replica: "api-2", worker: "notification-delivery-external" },
      ],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("api-2");
  });

  it("pages when connections near max_connections", () => {
    expect(
      evaluateAlerts({
        ...healthy(),
        connectionUsagePercent: DEFAULT_ALERT_THRESHOLDS.connectionUsagePercent,
      }),
    ).toHaveLength(1);
  });

  it("pages when Redis does not answer", () => {
    expect(evaluateAlerts({ ...healthy(), redisOk: false })).toHaveLength(1);
  });

  it("reports a part of the check that could not be read", () => {
    const reasons = evaluateAlerts({
      ...healthy(),
      collectionErrors: ["worker_heartbeat: relation does not exist"],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("worker_heartbeat");
  });
});

/**
 * The ICP-Brasil A1 certificate that signs the proof documents (decision
 * 14.8, design §6.3/§7.4). It expires once a year; without a warning the
 * receipts silently start going out unsigned the day it does.
 */
describe("the proof signing certificate", () => {
  const DAY = 24 * HOUR;

  function withCertificate(
    proofSigning: OperationalSnapshot["proofSigning"],
  ): OperationalSnapshot {
    return { ...healthy(), proofSigning };
  }

  it("raises nothing when none is configured, or signing is switched off", () => {
    expect(
      evaluateAlerts(
        withCertificate({ state: "ABSENT", reason: null, notAfter: null }),
      ),
    ).toEqual([]);
    expect(
      evaluateAlerts(
        withCertificate({ state: "DISABLED", reason: null, notAfter: null }),
      ),
    ).toEqual([]);
  });

  it("raises nothing for a certificate with more than 30 days left", () => {
    expect(
      evaluateAlerts(
        withCertificate({
          state: "READY",
          reason: null,
          notAfter: new Date(NOW.getTime() + 31 * DAY),
        }),
      ),
    ).toEqual([]);
  });

  it("warns 30 days before it expires", () => {
    const reasons = evaluateAlerts(
      withCertificate({
        state: "READY",
        reason: null,
        notAfter: new Date(NOW.getTime() + 20 * DAY),
      }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/certificado/i);
    expect(reasons[0]).toContain("20 dia(s)");
    expect(reasons[0]).not.toMatch(/crítico/i);
  });

  it("is critical in the last 7 days", () => {
    const reasons = evaluateAlerts(
      withCertificate({
        state: "READY",
        reason: null,
        notAfter: new Date(NOW.getTime() + 3 * DAY),
      }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/crítico/i);
  });

  it("pages when the configured certificate expired or cannot be opened", () => {
    const expired = evaluateAlerts(
      withCertificate({
        state: "EXPIRED",
        reason: null,
        notAfter: new Date(NOW.getTime() - DAY),
      }),
    );
    const invalid = evaluateAlerts(
      withCertificate({
        state: "INVALID",
        reason: "PFX_UNREADABLE",
        notAfter: null,
      }),
    );

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatch(/vencido/i);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("PFX_UNREADABLE");
  });
});

/**
 * The scale plan's database and Redis rules (plano-escala F1-11). The
 * cluster's own numbers already reach the series every minute (F1-10); these
 * rules make the ones that stop a database page before they do:
 *
 *  - PITR expected (PITR_EXPECTED=true) and archive_mode is not on: the WAL
 *    is not leaving the machine and there is no restore to the minute;
 *  - archiving on and the last segment archived more than 300 s ago
 *    (archive_timeout is 60 s), or the latest attempt failed: pg_wal grows
 *    on a disk two productions share;
 *  - the cluster's xid age past a billion: the freeze is falling behind;
 *  - a write transaction open longer than LONG_WRITE_XACT_ALERT_SECONDS: it
 *    holds the vacuum back and, with the feed, the integration;
 *  - pg_wal past PG_WAL_ALERT_GIB;
 *  - Redis evicting keys in the last 15 minutes (the delta against the
 *    'cluster' row), and Redis without a ceiling or with noeviction.
 *
 * Each is pinned one below, at and one past its threshold (a rule reads
 * "more than"), and each fires only its own reason.
 */
describe("the database and Redis rules of the scale plan", () => {
  const T = DEFAULT_ALERT_THRESHOLDS;
  const GIB = 1024 ** 3;

  type DatabaseState = NonNullable<OperationalSnapshot["database"]>;
  type RedisState = NonNullable<OperationalSnapshot["redis"]>;

  function cluster(
    databaseOverrides: Partial<DatabaseState> = {},
    redisOverrides: Partial<RedisState> = {},
  ): OperationalSnapshot {
    return {
      ...healthy(),
      database: {
        archiveMode: "on",
        lastArchivedAgeSec: 30,
        lastArchivedAt: new Date(NOW.getTime() - 30_000),
        lastArchiveFailedAt: null,
        archiveFailedCount: 0,
        xidAge: 200_000_000,
        oldestWriteXactSec: 2,
        pgWalBytes: GIB,
        ...databaseOverrides,
      },
      redis: {
        up: true,
        maxmemoryMb: 256,
        maxmemoryPolicy: "allkeys-lru",
        evictedKeys: { delta: 0, windowSec: 900 },
        ...redisOverrides,
      },
    };
  }

  it("raises nothing for a healthy cluster, PITR expected or not", () => {
    expect(evaluateAlerts(cluster())).toEqual([]);
    expect(evaluateAlerts(cluster(), T, { pitrExpected: true })).toEqual([]);
  });

  it("raises nothing when the collector did not read the cluster", () => {
    // A snapshot without the blocks (a test, an older caller) judges as before.
    expect(evaluateAlerts(healthy(), T, { pitrExpected: true })).toEqual([]);
  });

  it.each([
    {
      rule: "the archiver's lag",
      field: "lastArchivedAgeSec" as const,
      limit: T.archiveLagSec,
      reason: /Arquivamento do WAL parado/,
    },
    {
      rule: "the cluster's xid age",
      field: "xidAge" as const,
      limit: T.xidAge,
      reason: /idade do xid/,
    },
    {
      rule: "the oldest write transaction",
      field: "oldestWriteXactSec" as const,
      limit: T.longWriteXactSec,
      reason: /escrita aberta há/,
    },
    {
      rule: "pg_wal",
      field: "pgWalBytes" as const,
      limit: T.pgWalBytes,
      reason: /pg_wal com/,
    },
  ])(
    "pages on $rule one past the threshold, never at it or below",
    ({ field, limit, reason }) => {
      expect(evaluateAlerts(cluster({ [field]: limit - 1 }))).toEqual([]);
      expect(evaluateAlerts(cluster({ [field]: limit }))).toEqual([]);

      const reasons = evaluateAlerts(cluster({ [field]: limit + 1 }));

      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(reason);
    },
  );

  it("pages on one key evicted in the window, never on none", () => {
    expect(
      evaluateAlerts(
        cluster({}, { evictedKeys: { delta: 0, windowSec: 900 } }),
      ),
    ).toEqual([]);

    const reasons = evaluateAlerts(
      cluster({}, { evictedKeys: { delta: 1, windowSec: 900 } }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/Redis despejou 1 chave\(s\) em 15 min/);
  });

  it("stays silent on evictions while there is no row to compare with", () => {
    // The first 15 minutes after a deploy, or OPS_SAMPLE_ENABLED=false.
    expect(evaluateAlerts(cluster({}, { evictedKeys: null }))).toEqual([]);
  });

  it("pages on archive_mode off only when PITR is expected", () => {
    const off = cluster({
      archiveMode: "off",
      lastArchivedAgeSec: null,
      lastArchivedAt: null,
    });

    expect(evaluateAlerts(off)).toEqual([]);
    expect(evaluateAlerts(off, T, { pitrExpected: false })).toEqual([]);

    const reasons = evaluateAlerts(off, T, { pitrExpected: true });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/PITR_EXPECTED=true/);
    expect(reasons[0]).toContain('"off"');
  });

  it("counts a standby's archive_mode always as archiving", () => {
    expect(
      evaluateAlerts(cluster({ archiveMode: "always" }), T, {
        pitrExpected: true,
      }),
    ).toEqual([]);
  });

  it("pages when the latest archive attempt failed, not on an old failure", () => {
    const reasons = evaluateAlerts(
      cluster({
        lastArchivedAt: new Date(NOW.getTime() - 60_000),
        lastArchiveFailedAt: new Date(NOW.getTime() - 10_000),
        archiveFailedCount: 4,
      }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/Arquivamento do WAL falhando/);
    expect(reasons[0]).toContain("4");

    // A failure followed by a success is an archiver that recovered.
    expect(
      evaluateAlerts(
        cluster({
          lastArchivedAt: new Date(NOW.getTime() - 10_000),
          lastArchiveFailedAt: new Date(NOW.getTime() - 60_000),
          archiveFailedCount: 4,
        }),
      ),
    ).toEqual([]);

    // Nothing archived yet and a failure: failing from the first segment.
    expect(
      evaluateAlerts(
        cluster({
          lastArchivedAgeSec: null,
          lastArchivedAt: null,
          lastArchiveFailedAt: new Date(NOW.getTime() - 10_000),
          archiveFailedCount: 1,
        }),
      ),
    ).toHaveLength(1);
  });

  it("leaves the archiver alone while archiving is off", () => {
    // archive_mode off: pg_stat_archiver keeps whatever an old setup left,
    // and nothing is being archived to judge.
    expect(
      evaluateAlerts(
        cluster({
          archiveMode: "off",
          lastArchivedAgeSec: 86_400,
          lastArchivedAt: new Date(NOW.getTime() - 86_400_000),
          lastArchiveFailedAt: new Date(NOW.getTime() - 3_600_000),
          archiveFailedCount: 9,
        }),
      ),
    ).toEqual([]);
  });

  it("pages once on a Redis without a ceiling, with noeviction, or both", () => {
    const noCeiling = evaluateAlerts(cluster({}, { maxmemoryMb: null }));
    const noEviction = evaluateAlerts(
      cluster({}, { maxmemoryPolicy: "noeviction" }),
    );
    const both = evaluateAlerts(
      cluster({}, { maxmemoryMb: null, maxmemoryPolicy: "noeviction" }),
    );

    expect(noCeiling).toHaveLength(1);
    expect(noCeiling[0]).toMatch(/sem teto de memória/);
    expect(noEviction).toHaveLength(1);
    expect(noEviction[0]).toMatch(/noeviction/);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatch(/sem teto de memória/);
    expect(both[0]).toMatch(/noeviction/);
  });

  it("leaves the Redis memory rule to the Redis rule when it is down", () => {
    const reasons = evaluateAlerts({
      ...cluster(
        {},
        {
          up: false,
          maxmemoryMb: null,
          maxmemoryPolicy: null,
          evictedKeys: null,
        },
      ),
      redisOk: false,
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/Redis sem resposta/);
  });

  it("raises only its own reason for each rule", () => {
    const cases: Array<[OperationalSnapshot, boolean]> = [
      [cluster({ archiveMode: "off", lastArchivedAgeSec: null }), true],
      [cluster({ lastArchivedAgeSec: T.archiveLagSec + 60 }), false],
      [
        cluster({
          lastArchiveFailedAt: new Date(NOW.getTime() - 1_000),
          archiveFailedCount: 1,
        }),
        false,
      ],
      [cluster({ xidAge: T.xidAge * 1.5 }), false],
      [cluster({ oldestWriteXactSec: T.longWriteXactSec * 2 }), false],
      [cluster({ pgWalBytes: T.pgWalBytes * 2 }), false],
      [cluster({}, { evictedKeys: { delta: 50, windowSec: 900 } }), false],
      [cluster({}, { maxmemoryPolicy: "noeviction" }), false],
    ];

    const reasons = cases.map(([snapshot, pitrExpected]) =>
      evaluateAlerts(snapshot, T, { pitrExpected }),
    );

    for (const list of reasons) expect(list).toHaveLength(1);

    // Eight rules, eight different reasons.
    expect(new Set(reasons.map((list) => list[0])).size).toBe(cases.length);
  });
});

describe("the thresholds the environment sets", () => {
  it("takes the long write and pg_wal limits from the variables", () => {
    const thresholds = alertThresholdsFromEnv({
      LONG_WRITE_XACT_ALERT_SECONDS: 60,
      PG_WAL_ALERT_GIB: 8,
    });

    expect(thresholds.longWriteXactSec).toBe(60);
    expect(thresholds.pgWalBytes).toBe(8 * 1024 ** 3);
    // The rest stays the code's.
    expect(thresholds.archiveLagSec).toBe(
      DEFAULT_ALERT_THRESHOLDS.archiveLagSec,
    );
    expect(thresholds.outboxLagSec).toBe(DEFAULT_ALERT_THRESHOLDS.outboxLagSec);
  });

  it("keeps the plan's defaults: 300 s, a billion, 120 s and 12 GiB", () => {
    expect(DEFAULT_ALERT_THRESHOLDS.archiveLagSec).toBe(300);
    expect(DEFAULT_ALERT_THRESHOLDS.xidAge).toBe(1_000_000_000);
    expect(DEFAULT_ALERT_THRESHOLDS.longWriteXactSec).toBe(120);
    expect(DEFAULT_ALERT_THRESHOLDS.pgWalBytes).toBe(12 * 1024 ** 3);
  });
});
