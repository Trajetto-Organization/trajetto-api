import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  alertThresholdsFromEnv,
  collectAlerts,
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

  /**
   * The grace is for a purge that does nothing but partials. When a run that
   * really failed came after the last success, the reader leaves
   * partialSince null: one partial after two days of a statement timeout
   * used to silence a job already overdue, for another 26 h.
   */
  it("still pages an overdue job when a real failure came before the partial", () => {
    const partialAfterFailures = (lastSucceededAt: Date | null) =>
      evaluateAlerts({
        ...healthy(),
        cronJobs: [
          {
            job: "cleanup-notification-pipeline",
            lastStatus: "FAILED",
            lastSucceededAt,
            staleRunning: 0,
            lastPartial: true,
            partialSince: null,
          },
        ],
      });

    const overdue = partialAfterFailures(new Date(NOW.getTime() - 72 * HOUR));

    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatch(
      /sem execução bem-sucedida há mais de 26h \(último status: FAILED\)/,
    );

    expect(partialAfterFailures(null)).toEqual([
      expect.stringMatching(/nenhuma execução bem-sucedida registrada/),
    ]);

    // A success inside the 26 h is not overdue, partial or not.
    expect(partialAfterFailures(new Date(NOW.getTime() - 20 * HOUR))).toEqual(
      [],
    );
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

  /**
   * Every registered partitioned table (plano-escala F2-09). The runway
   * alert at 3 days arrived with inserts a few nights from refused; the
   * lookahead alert at 5 is the warning with time to act, and a partition
   * past its retention that the job keeps failing to drop has its own code.
   * One alert per table and threshold, never both lookahead codes at once.
   */
  describe("the registered partitioned tables", () => {
    const table = (
      overrides: Partial<{
        table: string;
        lookaheadDays: number | null;
        runwayOk: boolean;
        lookaheadOk: boolean;
        stuck: string[];
        stuckGraceDays: number;
        dropGate: string;
      }> = {},
    ) => ({
      table: "driver_position",
      lookaheadDays: 7,
      runwayOk: true,
      lookaheadOk: true,
      stuck: [],
      ...overrides,
    });

    const codes = (partitions: ReturnType<typeof table>[]) =>
      collectAlerts({ ...healthy(), partitions }).map((alert) => alert.code);

    it("say nothing with a week ahead and nothing stuck", () => {
      expect(codes([table()])).toEqual([]);
    });

    it("warn with 4 days ahead, before the runway alert", () => {
      const alerts = collectAlerts({
        ...healthy(),
        partitions: [table({ lookaheadDays: 4, lookaheadOk: false })],
      });

      expect(alerts.map((alert) => alert.code)).toEqual([
        "partition-lookahead-low",
      ]);
      expect(alerts[0].message).toContain("driver_position: só 4 dia(s)");
    });

    it("page with the runway alert alone under 3 days", () => {
      expect(
        codes([
          table({ lookaheadDays: 2, runwayOk: false, lookaheadOk: false }),
        ]),
      ).toEqual(["partition-runway-low"]);
    });

    it("name the stuck partitions, a few of them", () => {
      const alerts = collectAlerts({
        ...healthy(),
        partitions: [
          table({
            stuck: [
              "driver_position_20260101",
              "driver_position_20260102",
              "driver_position_20260103",
              "driver_position_20260104",
            ],
          }),
        ],
      });

      expect(alerts.map((alert) => alert.code)).toEqual(["partition-stuck"]);
      expect(alerts[0].message).toContain("4 partição(ões)");
      expect(alerts[0].message).toContain("e mais 1");
    });

    it("say a queue's day waits for its gate, with the queue's own grace", () => {
      // F5-11: a day of the notification family leaves only settled, and
      // its grace is QUEUE_PARTITION_STUCK_ALERT_DAYS.
      const alerts = collectAlerts({
        ...healthy(),
        partitions: [
          table({
            table: "domain_outbox_event",
            stuck: ["domain_outbox_event_20261020"],
            stuckGraceDays: 5,
            dropGate: "notification-family",
          }),
        ],
      });

      expect(alerts[0].message).toContain("há mais de 5 dias");
      expect(alerts[0].message).toContain("sem linha em voo");
      expect(
        collectAlerts({
          ...healthy(),
          partitions: [table({ stuck: ["driver_position_20260101"] })],
        })[0].message,
      ).toContain("há mais de 3 dias");
    });

    it("judge every table, and ignore the old driver_position fields when they are there", () => {
      expect(
        codes([table(), table({ lookaheadDays: 4, lookaheadOk: false })])
          .length,
      ).toBe(1);

      // The per-table states replace the legacy fields.
      expect(
        collectAlerts({
          ...healthy(),
          partitionRunwayOk: false,
          partitionRunwayDays: 2,
          partitions: [table()],
        }),
      ).toEqual([]);
    });
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

/**
 * plano-escala F3-34: the fleet of process_heartbeat. With the queues in a
 * worker and the requests in the api, a worker that is down left due rows
 * with nobody to take them, and the lag rules spoke only after 5 to 30
 * minutes, without saying why; a role left on the old build ran beside the
 * new one in silence; and a process of the other environment pointed at
 * this database (the dokploy-network is shared) took its rows with the
 * wrong settings.
 */
describe("the processes of process_heartbeat", () => {
  const MIN = 60_000;
  const ALL_QUEUES = [
    "outbox",
    "internal",
    "external",
    "webhooks",
    "ai",
    "jobs",
  ];

  const process_ = (
    replica: string,
    extra: Partial<
      NonNullable<OperationalSnapshot["processes"]>["live"][number]
    > = {},
  ) => ({
    replica,
    role: "api",
    appEnv: "production",
    commit: "abc1234",
    queues: [] as string[],
    startedAt: new Date(NOW.getTime() - 2 * HOUR),
    ...extra,
  });

  const fleet = (
    ...live: NonNullable<OperationalSnapshot["processes"]>["live"]
  ): OperationalSnapshot["processes"] => ({ appEnv: "production", live });

  const codes = (snapshot: OperationalSnapshot) =>
    collectAlerts(snapshot).map((alert) => alert.code);

  it("pages for a queue with a row due past two minutes and no live consumer", () => {
    const alerts = collectAlerts({
      ...healthy(),
      outboxEligibleLagSec: 130,
      // The api in PROCESS_ROLE=api, and no worker.
      processes: fleet(process_("api-1"), process_("api-2")),
    }).filter((alert) => alert.code === "queue-no-consumer");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("fila outbox");
    expect(alerts[0].message).toContain("item devido há 130s");
  });

  it("says nothing while the queue has a consumer, or the row is fresh", () => {
    expect(
      codes({
        ...healthy(),
        outboxEligibleLagSec: 130,
        processes: fleet(
          process_("api-1"),
          process_("worker-1", { role: "worker", queues: ALL_QUEUES }),
        ),
      }),
    ).not.toContain("queue-no-consumer");

    expect(
      codes({
        ...healthy(),
        outboxEligibleLagSec: 119,
        processes: fleet(process_("api-1")),
      }),
    ).not.toContain("queue-no-consumer");
  });

  it("names each queue left without a consumer, the lanes apart", () => {
    const alerts = collectAlerts({
      ...healthy(),
      deliveryEligibleLagSec: { internal: 1, external: 600 },
      webhookDueLagSec: 300,
      processes: fleet(
        process_("worker-1", {
          role: "worker",
          queues: ["outbox", "internal", "ai", "jobs"],
        }),
      ),
    }).filter((alert) => alert.code === "queue-no-consumer");

    expect(alerts.map((alert) => alert.message)).toEqual([
      expect.stringContaining("fila external"),
      expect.stringContaining("fila webhooks"),
    ]);
  });

  it("does not count a process of the other environment as a consumer", () => {
    expect(
      codes({
        ...healthy(),
        outboxEligibleLagSec: 300,
        processes: fleet(
          process_("staging-worker", {
            role: "worker",
            appEnv: "staging",
            queues: ALL_QUEUES,
          }),
        ),
      }),
    ).toEqual(
      expect.arrayContaining(["queue-no-consumer", "foreign-environment"]),
    );
  });

  it("pages for processes on two commits for more than half an hour", () => {
    const alerts = collectAlerts({
      ...healthy(),
      processes: fleet(
        process_("api-1", { commit: "newcommit00001" }),
        // The worker left on the old build: started days ago, still there.
        process_("worker-1", {
          role: "worker",
          commit: "oldcommit00001",
          queues: ALL_QUEUES,
          startedAt: new Date(NOW.getTime() - 48 * HOUR),
        }),
        process_("api-2", {
          commit: "newcommit00001",
          startedAt: new Date(NOW.getTime() - 31 * MIN),
        }),
      ),
    }).filter((alert) => alert.code === "mixed-versions");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("2 commits diferentes");
    expect(alerts[0].message).toContain("oldcommit000 (1: worker)");
    expect(alerts[0].message).toContain("newcommit000 (2: api)");
  });

  it("gives a rolling deploy its half hour, counted from when the new commit arrived", () => {
    expect(
      codes({
        ...healthy(),
        processes: fleet(
          process_("api-1", {
            commit: "new",
            startedAt: new Date(NOW.getTime() - 29 * MIN),
          }),
          process_("worker-1", {
            role: "worker",
            commit: "old",
            queues: ALL_QUEUES,
            startedAt: new Date(NOW.getTime() - 48 * HOUR),
          }),
        ),
      }),
    ).not.toContain("mixed-versions");
  });

  it("pages for a row of another APP_ENV, naming the process", () => {
    const alerts = collectAlerts({
      ...healthy(),
      processes: fleet(
        process_("api-1", { role: "all", queues: ALL_QUEUES }),
        process_("stg-worker-1", { role: "worker", appEnv: "staging" }),
      ),
    }).filter((alert) => alert.code === "foreign-environment");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain(
      "1 processo(s) de APP_ENV=staging gravando no banco deste ambiente (production): worker em stg-worker-1",
    );
  });

  it("judges nothing without the rows, and nothing in today's single fleet", () => {
    expect(codes({ ...healthy(), outboxEligibleLagSec: 200 })).not.toContain(
      "queue-no-consumer",
    );

    expect(
      evaluateAlerts({
        ...healthy(),
        processes: fleet(
          process_("api-1", { role: "all", queues: ALL_QUEUES }),
          process_("api-2", { role: "all", queues: ALL_QUEUES }),
        ),
      }),
    ).toEqual([]);
  });
});
