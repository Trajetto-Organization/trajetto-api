import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  alertThresholdsFromEnv,
  collectAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  carriesVolumeTotals,
  countDeliveriesCreated,
  rotateDeliveriesCreated,
  volumeSection,
} from "@/shared/health/volume-gauge";

/**
 * The ramp's gauge (plano-escala U-12).
 *
 * One VPS takes the monthly volume the newest approved load report proved
 * (APPROVED_GATE_MONTHLY_DELIVERIES, 10 000 today). A customer's ramp that
 * walks past it finds out on the day of its peak, with production down.
 * The ops heartbeat now says it first — and only says it: nothing refuses
 * a delivery. What this pins:
 *
 *  - the counter counts what each process created, and resets as the
 *    minute's ops_sample row reads it;
 *  - every path that creates deliveries counts AFTER its transaction
 *    commits, never inside it: inside, a rollback would leave the count
 *    behind (the plan's risk, "tentativas que depois falham");
 *  - the 7 days, projected to a month (× 30/7), past 70% of the gate page,
 *    and the last 24 h past the soft cap page, with one stable code.
 *
 * The cluster row's sum against the real series is
 * tests/E2E/volume-gauge.test.ts.
 */

const NOW = new Date("2026-11-15T12:00:00Z");

function snapshot(volume?: OperationalSnapshot["volume"]): OperationalSnapshot {
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
    ...(volume ? { volume } : {}),
  };
}

function volumeCodes(
  volume: OperationalSnapshot["volume"],
  env: Parameters<typeof alertThresholdsFromEnv>[0],
) {
  return collectAlerts(snapshot(volume), alertThresholdsFromEnv(env)).filter(
    (alert) => alert.code === "volume-near-gate",
  );
}

const BASE_ENV = { LONG_WRITE_XACT_ALERT_SECONDS: 120, PG_WAL_ALERT_GIB: 12 };

describe("the process counter", () => {
  it("counts what this process created and resets as the minute reads it", () => {
    rotateDeliveriesCreated();

    countDeliveriesCreated();
    countDeliveriesCreated();
    countDeliveriesCreated(3);

    expect(rotateDeliveriesCreated()).toEqual({ created: 5 });
    expect(rotateDeliveriesCreated()).toEqual({ created: 0 });
  });

  it("ignores anything that is not a positive whole count", () => {
    rotateDeliveriesCreated();

    for (const nonsense of [0, -1, 1.5, Number.NaN, Infinity]) {
      countDeliveriesCreated(nonsense);
    }

    expect(rotateDeliveriesCreated()).toEqual({ created: 0 });
  });
});

/** Every .ts file under src/. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

/** The index of the brace that closes the one at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0;

  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }

  return -1;
}

describe("the paths that create deliveries", () => {
  const SRC = resolve(process.cwd(), "src");

  const creators = sourceFiles(SRC)
    .filter((path) => !/[\\/]repositories[\\/]/.test(path))
    .filter((path) => /\.createDelivery\(/.test(readFileSync(path, "utf8")));

  it("are the four the plan names: panel, integration, spreadsheet and XML", () => {
    // A new path (the integration batch) joins this list with its count.
    expect(
      creators.map((path) => relative(SRC, path).replace(/\\/g, "/")).sort(),
    ).toEqual([
      "modules/delivery/usecases/create-delivery/create-delivery-usecase.ts",
      "modules/delivery/usecases/import-delivery-xml/import-delivery-xml-usecase.ts",
      "modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase.ts",
      "modules/integration/usecases/create-delivery/create-integration-delivery-usecase.ts",
    ]);
  });

  it("each count after the transaction that wrote the row commits", () => {
    for (const path of creators) {
      const text = readFileSync(path, "utf8");
      const name = relative(SRC, path);
      const create = text.search(/\.createDelivery\(/);

      // The transaction whose callback holds the insert.
      const transaction = text.lastIndexOf("database.$transaction(", create);
      expect(transaction, `${name}: no transaction`).toBeGreaterThan(-1);

      const body = text.indexOf("{", transaction);
      const end = closingBrace(text, body);
      expect(end, `${name}: unbalanced`).toBeGreaterThan(create);

      const count = text.indexOf("countDeliveriesCreated()", end);

      expect(count, `${name}: never counts after the commit`).toBeGreaterThan(
        end,
      );
      expect(
        text.slice(body, end),
        `${name}: counts inside the transaction`,
      ).not.toContain("countDeliveriesCreated");
    }
  });
});

describe("the cluster row's section", () => {
  const SLOT = new Date("2026-11-15T12:15:00Z");

  it("carries the totals only on the quarter-hour that summed them", () => {
    const totals = {
      last24h: 40,
      last7d: 200,
      since: new Date("2026-11-10T00:00:00Z"),
      at: SLOT,
    };

    expect(volumeSection({ created: 3, totals }, SLOT)).toEqual({
      created: 3,
      last_24h: 40,
      last_7d: 200,
      since: "2026-11-10T00:00:00.000Z",
    });

    // A minute later the alerts still judge them; the row does not copy them.
    const later = new Date("2026-11-15T12:16:00Z");

    expect(volumeSection({ created: 1, totals }, later)).toEqual({
      created: 1,
    });
    expect(volumeSection({ created: 0, totals: null }, later)).toEqual({
      created: 0,
    });
  });

  it("sums on the quarter-hours", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 3, minute));

    for (const minute of [0, 15, 30, 45]) {
      expect(carriesVolumeTotals(at(minute))).toBe(true);
    }
    expect(carriesVolumeTotals(at(16))).toBe(false);
  });
});

describe("the ramp's alert", () => {
  // The plan's acceptance reads "80 deliveries against a gate of 100
  // pages, 60 does not": a monthly volume at 80% and 60% of the gate. The
  // rule projects the 7 days to a month (× 30/7), so with a gate of 300
  // that is 56 and 42 deliveries in the week: 240 and 180 a month.
  const GATE_300 = { ...BASE_ENV, APPROVED_GATE_MONTHLY_DELIVERIES: 300 };

  it("pages at 80% of the gate and stays quiet at 60%", () => {
    const at80 = volumeCodes({ last24h: 8, last7d: 56 }, GATE_300);

    expect(at80).toHaveLength(1);
    expect(at80[0].message).toMatch(
      /^Volume de entregas perto do portão aprovado: 56 nos últimos 7 dias, cerca de 240 por mês \(80% de 300/,
    );

    expect(volumeCodes({ last24h: 6, last7d: 42 }, GATE_300)).toEqual([]);
  });

  it("pages from just past 70%, not at it", () => {
    // 70% of 700 is 490 a month: 114.33 a week.
    const gate700 = { ...BASE_ENV, APPROVED_GATE_MONTHLY_DELIVERIES: 700 };

    expect(volumeCodes({ last24h: 0, last7d: 114 }, gate700)).toEqual([]);
    expect(volumeCodes({ last24h: 0, last7d: 115 }, gate700)).toHaveLength(1);
  });

  it("uses today's step, 10 000 a month, without the variable", () => {
    expect(DEFAULT_ALERT_THRESHOLDS.approvedGateMonthlyDeliveries).toBe(
      10_000,
    );

    // 1 633 a week is 6 999 a month; 1 634 is 7 003.
    expect(volumeCodes({ last24h: 0, last7d: 1_633 }, BASE_ENV)).toEqual([]);
    expect(volumeCodes({ last24h: 0, last7d: 1_634 }, BASE_ENV)).toHaveLength(
      1,
    );
  });

  it("has no daily cap until one is set, and only pages past it", () => {
    const huge = { last24h: 1_000_000, last7d: 0 };

    expect(volumeCodes(huge, BASE_ENV)).toEqual([]);

    const capped = { ...BASE_ENV, PLATFORM_DAILY_DELIVERY_SOFT_CAP: 500 };

    expect(volumeCodes({ last24h: 500, last7d: 0 }, capped)).toEqual([]);

    const past = volumeCodes({ last24h: 501, last7d: 0 }, capped);

    expect(past).toHaveLength(1);
    expect(past[0].message).toMatch(
      /^Volume de entregas acima do teto diário: 501 nas últimas 24 h \(PLATFORM_DAILY_DELIVERY_SOFT_CAP 500\); nada é recusado/,
    );
  });

  it("judges nothing without a reading", () => {
    expect(
      collectAlerts(snapshot(), alertThresholdsFromEnv(BASE_ENV)).filter(
        (alert) => alert.code === "volume-near-gate",
      ),
    ).toEqual([]);
  });
});
