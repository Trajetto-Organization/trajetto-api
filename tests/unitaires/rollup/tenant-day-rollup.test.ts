import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "@/env";
import { PartialRunError } from "@/shared/errors/partial-run-error";
import { InMemoryTenantDayRollupRepository } from "@/shared/rollup/in-memory-tenant-day-rollup-repository";
import { rollUpTenantDays } from "@/shared/rollup/tenant-day-rollup";
import type { ITenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";
import {
  PENDING_DELIVERY_METRIC,
  dayBounds,
  daysBetween,
  deliveryMetric,
  rollupZones,
  zoneCalendar,
} from "@/shared/rollup/tenant-day-rules";
import { businessDateKey, shiftDateKey } from "@/shared/time/business-day";
import {
  TENANT_DAY_ROLLUP_JOB,
  runTenantDayRollup,
  tenantDayRollupJob,
} from "@/jobs/cron/tenant-day-rollup-job";

/**
 * A run of the dashboard's rollup (plano-escala F4-21) over the twin, whose
 * semantics the contract suite holds to the database's: what a run stores
 * is the exact count of each closed day in three zones, a changed old day
 * is counted again from its mark, and a run that stops (the budget, the
 * wait, a statement that lost) leaves no hole and nothing lost. The
 * database's half (the wait for a writer that skipped a mark) is the E2E
 * tenant-day-rollup.test.ts.
 */

const NOW = new Date("2026-11-19T02:30:00.000Z");
const SAO_PAULO = "America/Sao_Paulo";
const MANAUS = "America/Manaus";
const NORONHA = "America/Noronha";

const PAULISTA = "018f6a00-0000-7000-8000-00000000000a";
const AMAZONICA = "018f6a00-0000-7000-8000-00000000000b";
const ILHEU = "018f6a00-0000-7000-8000-00000000000c";

const COMPANIES = [
  { id: PAULISTA, zone: SAO_PAULO },
  { id: AMAZONICA, zone: MANAUS },
  { id: ILHEU, zone: NORONHA },
];

let repo: InMemoryTenantDayRollupRepository;

/** The twin with some methods replaced; the others act on the twin itself. */
function overriding(
  overrides: Partial<ITenantDayRollupRepository>,
): ITenantDayRollupRepository {
  return new Proxy(repo, {
    get(target, property, receiver) {
      if (property in overrides) {
        return overrides[property as keyof ITenantDayRollupRepository];
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A delivery of the company created about `days` days before NOW. */
function takeDeliveryOf(businessId: string, days: number): Date {
  const index = repo.deliveries.findIndex(
    (delivery) =>
      delivery.businessId === businessId &&
      Math.abs(NOW.getTime() - delivery.created_at.getTime() - days * DAY_MS) <
        DAY_MS,
  );
  const [removed] = repo.deliveries.splice(index, 1);

  return removed.created_at;
}

/** Deliveries a minute either side of each zone's midnight and of UTC's. */
function seedAround(businessId: string, daysBack: number[]): void {
  for (const back of daysBack) {
    for (const zone of [SAO_PAULO, MANAUS, NORONHA, "UTC"]) {
      const midnight = dayBounds(
        shiftDateKey(businessDateKey(NOW, zone), -back),
        zone,
      ).from.getTime();

      for (const offset of [-60_000, 0, 60_000]) {
        repo.deliveries.push({
          businessId,
          created_at: new Date(midnight + offset),
        });
      }
    }
  }
}

/** Each civil day's count, filed by the zone's wall clock: not by dayBounds. */
function expected(businessId: string, zone: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const delivery of repo.deliveries) {
    if (delivery.businessId !== businessId) continue;

    const day = businessDateKey(delivery.created_at, zone);

    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  return counts;
}

function stored(businessId: string, metric: string): Map<string, number> {
  return new Map(
    [...repo.days.values()]
      .filter((row) => row.businessId === businessId && row.metric === metric)
      .map((row) => [row.day, row.value]),
  );
}

function pendingOf(businessId: string): string[] {
  return [...stored(businessId, PENDING_DELIVERY_METRIC).keys()].sort();
}

/** Every stored day of every metric is exact, and the days have no hole. */
function expectExactAndWhole(options: { complete: boolean }): void {
  for (const company of COMPANIES) {
    for (const zone of rollupZones(company.zone)) {
      const calendar = zoneCalendar(NOW, zone);
      const days = stored(company.id, deliveryMetric(zone));
      const keys = [...days.keys()].sort();

      if (options.complete) {
        expect(keys, `${company.id} ${zone}`).toEqual(
          daysBetween(calendar.historyStart, calendar.yesterday),
        );
      } else if (keys.length > 0) {
        expect(keys).toEqual(daysBetween(keys[0], keys[keys.length - 1]));
      }

      const counts = expected(company.id, zone);

      for (const [day, value] of days) {
        expect(value, `${company.id} ${zone} ${day}`).toBe(
          counts.get(day) ?? 0,
        );
      }
    }
  }
}

beforeEach(() => {
  repo = new InMemoryTenantDayRollupRepository();

  for (const company of COMPANIES) {
    repo.businesses.set(company.id, {
      timezone: company.zone,
      purgeState: null,
    });
    seedAround(company.id, [0, 1, 2, 8, 9, 40, 200, 380]);
  }
});

describe("a run of the rollup", () => {
  it("stores every closed day of the history, exact in each company's zone and in the platform's", async () => {
    const report = await rollUpTenantDays({ repo, now: NOW });

    expect(report.left).toEqual([]);
    expectExactAndWhole({ complete: true });

    // Today is never stored: it is counted live.
    for (const company of COMPANIES) {
      for (const zone of rollupZones(company.zone)) {
        expect(
          stored(company.id, deliveryMetric(zone)).has(
            zoneCalendar(NOW, zone).today,
          ),
        ).toBe(false);
      }
    }
  });

  it("counts an old day again from its mark, and takes the mark away", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    // A reversal removes a delivery of 40 days ago, out of the D−8 window:
    // only the mark brings the day back.
    const removed = takeDeliveryOf(AMAZONICA, 40);

    repo.markDay(AMAZONICA, removed.toISOString().slice(0, 10));

    const report = await rollUpTenantDays({ repo, now: NOW });

    expect(report.marksTaken).toBe(1);
    expect(report.pendingSettled).toBe(1);
    expect(repo.marks).toEqual([]);
    expect(pendingOf(AMAZONICA)).toEqual([]);
    expectExactAndWhole({ complete: true });
  });

  it("keeps the pending days when the wait for the writers in flight runs out", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const removed = takeDeliveryOf(PAULISTA, 200);
    const utcDay = removed.toISOString().slice(0, 10);
    const civilDay = businessDateKey(removed, SAO_PAULO);
    const before = stored(PAULISTA, deliveryMetric(SAO_PAULO)).get(civilDay);

    repo.markDay(PAULISTA, utcDay);

    const stopped = await rollUpTenantDays({
      repo: overriding({ settledSince: async () => false }),
      now: NOW,
      settleWaitMs: 0,
    });

    // The marks are gone, their days kept, and no count was taken of them.
    expect(stopped.left).toContain("settle");
    expect(repo.marks).toEqual([]);
    expect(pendingOf(PAULISTA)).toEqual([utcDay]);
    expect(stored(PAULISTA, deliveryMetric(SAO_PAULO)).get(civilDay)).toBe(
      before,
    );

    const next = await rollUpTenantDays({ repo, now: NOW });

    expect(next.left).toEqual([]);
    expect(pendingOf(PAULISTA)).toEqual([]);
    expectExactAndWhole({ complete: true });
  });

  it("stops at the budget with no hole, and the next run goes on from there", async () => {
    let statements = 0;
    const counting = overriding({
      store: (groups) => {
        statements += 1;

        return repo.store(groups);
      },
    });

    // D−8 to D−1 of the five metrics is one statement; the backfill's
    // quarters, each metric's apart, are the next two before the budget.
    const first = await rollUpTenantDays({
      repo: counting,
      now: NOW,
      unitsPerStatement: 40,
      deadline: 1,
      clock: () => (statements >= 3 ? 1 : 0),
    });

    expect(statements).toBe(3);
    expect(first.left).toEqual(["backfill"]);
    expectExactAndWhole({ complete: false });

    const second = await rollUpTenantDays({ repo, now: NOW });

    expect(second.left).toEqual([]);
    expectExactAndWhole({ complete: true });
  });

  it("stops a phase on a statement that lost to a concurrent change, and fails on any other error", async () => {
    const lost = overriding({
      store: async () => {
        throw Object.assign(new Error("lock timeout"), {
          name: "DriverAdapterError",
          cause: { originalCode: "55P03" },
        });
      },
    });

    expect((await rollUpTenantDays({ repo: lost, now: NOW })).left).toEqual([
      "recount",
    ]);

    const broken = overriding({
      store: async () => {
        throw new Error("relation does not exist");
      },
    });

    await expect(rollUpTenantDays({ repo: broken, now: NOW })).rejects.toThrow(
      "relation does not exist",
    );
  });

  it("leaves a company being purged alone, and drops its marks", async () => {
    repo.businesses.set(ILHEU, { timezone: NORONHA, purgeState: "PURGING" });
    repo.markDay(ILHEU, "2026-11-10");

    const report = await rollUpTenantDays({ repo, now: NOW });

    expect(report.businesses).toBe(2);
    expect(repo.marks).toEqual([]);
    expect(
      [...repo.days.values()].filter((row) => row.businessId === ILHEU),
    ).toEqual([]);
  });

  it("counts a company again in the zone it moved to, and prunes the one it left", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    COMPANIES[1].zone = NORONHA;
    repo.businesses.set(AMAZONICA, { timezone: NORONHA, purgeState: null });

    try {
      const report = await rollUpTenantDays({ repo, now: NOW });

      expect(report.left).toEqual([]);
      expect(stored(AMAZONICA, deliveryMetric(MANAUS)).size).toBe(0);
      expectExactAndWhole({ complete: true });
    } finally {
      COMPANIES[1].zone = MANAUS;
    }
  });

  it("prunes the month that left the history when the month turns", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const december = new Date("2026-12-20T15:00:00.000Z");

    await rollUpTenantDays({ repo, now: december });

    for (const zone of [SAO_PAULO, MANAUS]) {
      const days = [...stored(AMAZONICA, deliveryMetric(zone)).keys()].sort();

      expect(days[0]).toBe("2025-12-01");
      expect(days[days.length - 1]).toBe(
        zoneCalendar(december, zone).yesterday,
      );
    }
  });
});

describe("the cron job", () => {
  const enabled = env.TENANT_DAY_ROLLUP_ENABLED;

  afterEach(() => {
    env.TENANT_DAY_ROLLUP_ENABLED = enabled;
  });

  it("runs every 15 minutes, off the hour's sweeps", () => {
    expect(tenantDayRollupJob.name).toBe(TENANT_DAY_ROLLUP_JOB);
    expect(tenantDayRollupJob.schedule).toBe("9,24,39,54 * * * *");
  });

  it("is on unless TENANT_DAY_ROLLUP_ENABLED=false, and then reads nothing", async () => {
    expect(enabled).toBe(true);

    env.TENANT_DAY_ROLLUP_ENABLED = false;

    const untouched = overriding({
      listBusinesses: async () => {
        throw new Error("read while off");
      },
    });

    expect(await runTenantDayRollup({ repo: untouched })).toBeNull();
  });

  it("ends partial, naming what was left, when a run stops with work to do", async () => {
    const error = await runTenantDayRollup({
      repo,
      now: NOW,
      deadline: 0,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PartialRunError);
    expect((error as PartialRunError).pending).toEqual(["recount"]);
  });
});
