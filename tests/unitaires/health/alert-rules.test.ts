import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
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
    expect(evaluateAlerts({ ...healthy(), webhookDueLagSec: null })).toEqual([]);
  });

  it("pages when due webhooks are not being taken", () => {
    const reasons = evaluateAlerts({ ...healthy(), webhookDueLagSec: 3_600 });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/webhook/i);
  });

  it("pages when AI analyses due are not being taken", () => {
    expect(evaluateAlerts({ ...healthy(), aiEligibleLagSec: 1_200 })).toHaveLength(1);
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
        { channel: "EMAIL", lastError: "[email smtp=EAUTH reply=535] Invalid login" },
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
    expect(evaluateAlerts({ ...healthy(), aiCredentialFailures: 1 })).toHaveLength(1);
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
        { job: "novo-job", lastStatus: "FAILED", lastSucceededAt: null, staleRunning: 0 },
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
          { job: "novo-job", lastStatus: null, lastSucceededAt: null, staleRunning: 0 },
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
      stuckWorkers: [{ replica: "api-2", worker: "notification-delivery-external" }],
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
    expect(evaluateAlerts(withCertificate({ state: "ABSENT", reason: null, notAfter: null }))).toEqual([]);
    expect(evaluateAlerts(withCertificate({ state: "DISABLED", reason: null, notAfter: null }))).toEqual([]);
  });

  it("raises nothing for a certificate with more than 30 days left", () => {
    expect(
      evaluateAlerts(
        withCertificate({ state: "READY", reason: null, notAfter: new Date(NOW.getTime() + 31 * DAY) }),
      ),
    ).toEqual([]);
  });

  it("warns 30 days before it expires", () => {
    const reasons = evaluateAlerts(
      withCertificate({ state: "READY", reason: null, notAfter: new Date(NOW.getTime() + 20 * DAY) }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/certificado/i);
    expect(reasons[0]).toContain("20 dia(s)");
    expect(reasons[0]).not.toMatch(/crítico/i);
  });

  it("is critical in the last 7 days", () => {
    const reasons = evaluateAlerts(
      withCertificate({ state: "READY", reason: null, notAfter: new Date(NOW.getTime() + 3 * DAY) }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/crítico/i);
  });

  it("pages when the configured certificate expired or cannot be opened", () => {
    const expired = evaluateAlerts(
      withCertificate({ state: "EXPIRED", reason: null, notAfter: new Date(NOW.getTime() - DAY) }),
    );
    const invalid = evaluateAlerts(
      withCertificate({ state: "INVALID", reason: "PFX_UNREADABLE", notAfter: null }),
    );

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatch(/vencido/i);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("PFX_UNREADABLE");
  });
});
