import { beforeEach, expect, it, vi } from "vitest";

import type { ITenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";
import { PENDING_DELIVERY_METRIC } from "@/shared/rollup/tenant-day-rules";

import type { Kind } from "../support";

/**
 * The dashboard's rollup repository (plano-escala F4-21): which companies
 * it counts, how a day is counted and stored, how the marks become pending
 * days and leave, and what a prune keeps. The same expectations for the SQL
 * and for the twin the job's unit tests run on.
 */

type PurgeState = "SCHEDULED" | "PURGING" | "PURGED" | null;

interface TenantDayRollupHarness {
  kind: Kind;
  repo: ITenantDayRollupRepository;
  /** No delivery, mark or stored day of the suite's companies; zones reset. */
  reset(): Promise<void>;
  setBusiness(
    id: string,
    state: { timezone: string; purgeState: PurgeState },
  ): Promise<void>;
  seedDelivery(businessId: string, createdAt: Date): Promise<void>;
  /** A mark as written, a duplicate too (two writers at once). */
  insertMark(businessId: string, day: string): Promise<void>;
  marks(): Promise<Array<{ businessId: string; day: string }>>;
  rows(
    businessId: string,
  ): Promise<Array<{ metric: string; day: string; value: number }>>;
}

const ALFA = "018f6b00-0000-7000-8000-00000000000a";
const BETA = "018f6b00-0000-7000-8000-00000000000b";
const GAMA = "018f6b00-0000-7000-8000-00000000000c";
/** A company deleted by hand: its marks outlive it (no foreign key). */
const GHOST = "018f6b00-0000-7000-8000-0000000000ff";

const COMPANIES = [ALFA, BETA, GAMA] as const;

const SP = "delivery@America/Sao_Paulo";
const MANAUS = "delivery@America/Manaus";

const FROM = new Date("2026-11-10T03:00:00.000Z");
const TO = new Date("2026-11-11T03:00:00.000Z");

function tenantDayRollupContract(harness: () => TenantDayRollupHarness): void {
  beforeEach(async () => {
    const h = harness();

    await h.reset();
    await h.setBusiness(ALFA, {
      timezone: "America/Sao_Paulo",
      purgeState: null,
    });
    await h.setBusiness(BETA, {
      timezone: "America/Manaus",
      purgeState: "SCHEDULED",
    });
    await h.setBusiness(GAMA, {
      timezone: "America/Noronha",
      purgeState: "PURGING",
    });
  });

  it("lists every company not being purged, by id, with its zone", async () => {
    const listed = await harness().repo.listBusinesses();

    expect(
      listed.filter((business) =>
        (COMPANIES as readonly string[]).includes(business.id),
      ),
    ).toEqual([
      { id: ALFA, timezone: "America/Sao_Paulo" },
      { id: BETA, timezone: "America/Manaus" },
    ]);
  });

  it("stores a day as the deliveries created in [from, to), a zero too, and replaces it", async () => {
    const h = harness();

    for (const instant of [
      new Date(FROM.getTime() - 1),
      FROM,
      new Date(TO.getTime() - 1),
      TO,
    ]) {
      await h.seedDelivery(ALFA, instant);
    }

    expect(
      await h.repo.store([
        {
          businessId: ALFA,
          units: [
            { metric: SP, day: "2026-11-10", from: FROM, to: TO },
            {
              metric: SP,
              day: "2026-11-12",
              from: new Date("2026-11-12T03:00:00.000Z"),
              to: new Date("2026-11-13T03:00:00.000Z"),
            },
          ],
          settle: [],
        },
      ]),
    ).toEqual({ stored: 2, settled: 0 });

    expect(await h.rows(ALFA)).toEqual([
      { metric: SP, day: "2026-11-10", value: 2 },
      { metric: SP, day: "2026-11-12", value: 0 },
    ]);

    await h.repo.store([
      {
        businessId: ALFA,
        units: [
          {
            metric: SP,
            day: "2026-11-10",
            from: new Date(FROM.getTime() - 1),
            to: TO,
          },
        ],
        settle: [],
      },
    ]);

    expect((await h.rows(ALFA))[0]).toEqual({
      metric: SP,
      day: "2026-11-10",
      value: 3,
    });
  });

  it("skips the days of a company being purged or gone, and stores the others", async () => {
    const h = harness();

    await h.seedDelivery(GAMA, FROM);

    const unit = { metric: SP, day: "2026-11-10", from: FROM, to: TO };

    expect(
      await h.repo.store([
        { businessId: GAMA, units: [unit], settle: [] },
        { businessId: GHOST, units: [unit], settle: [] },
        { businessId: BETA, units: [unit], settle: [] },
      ]),
    ).toEqual({ stored: 1, settled: 0 });
    expect(await h.rows(GAMA)).toEqual([]);
    expect(await h.rows(BETA)).toEqual([
      { metric: SP, day: "2026-11-10", value: 0 },
    ]);
  });

  it("reads the first and last stored day of each metric, and null for a metric without rows", async () => {
    const h = harness();
    const day = (key: string) => ({
      metric: SP,
      day: key,
      from: FROM,
      to: TO,
    });

    await h.repo.store([
      {
        businessId: ALFA,
        units: [day("2026-11-05"), day("2026-11-03"), day("2026-11-04")],
        settle: [],
      },
    ]);
    await h.insertMark(ALFA, "2026-01-01");
    await h.repo.takeDirtyMarks(10);

    expect(
      await h.repo.coverage([
        { businessId: ALFA, metric: SP },
        { businessId: ALFA, metric: MANAUS },
        { businessId: BETA, metric: SP },
      ]),
    ).toEqual([
      { businessId: ALFA, metric: MANAUS, first: null, last: null },
      { businessId: ALFA, metric: SP, first: "2026-11-03", last: "2026-11-05" },
      { businessId: BETA, metric: SP, first: null, last: null },
    ]);
  });

  it("takes the marks oldest first, up to the limit, keeping each company's day once", async () => {
    const h = harness();

    await h.insertMark(ALFA, "2026-11-01");
    await h.insertMark(ALFA, "2026-11-01");
    await h.insertMark(BETA, "2026-11-02");
    await h.insertMark(GHOST, "2026-11-03");
    await h.insertMark(GAMA, "2026-11-04");
    await h.insertMark(ALFA, "2026-11-05");

    expect(await h.repo.takeDirtyMarks(4)).toEqual({ taken: 4, added: 2 });
    expect(await h.marks()).toEqual([
      { businessId: GAMA, day: "2026-11-04" },
      { businessId: ALFA, day: "2026-11-05" },
    ]);

    // The company being purged and the one deleted lose their marks only.
    expect(await h.repo.takeDirtyMarks(10)).toEqual({ taken: 2, added: 1 });
    expect(await h.marks()).toEqual([]);
    expect(await h.repo.listPending([ALFA, BETA, GAMA, GHOST], 10)).toEqual([
      { businessId: ALFA, day: "2026-11-01" },
      { businessId: ALFA, day: "2026-11-05" },
      { businessId: BETA, day: "2026-11-02" },
    ]);
    expect(await h.rows(GAMA)).toEqual([]);
  });

  it("keeps a day pending once when it is marked again before being counted", async () => {
    const h = harness();

    await h.insertMark(ALFA, "2026-11-01");
    await h.repo.takeDirtyMarks(10);
    await h.insertMark(ALFA, "2026-11-01");

    expect(await h.repo.takeDirtyMarks(10)).toEqual({ taken: 1, added: 0 });
    expect(await h.rows(ALFA)).toEqual([
      { metric: PENDING_DELIVERY_METRIC, day: "2026-11-01", value: 0 },
    ]);
  });

  it("lists at most so many pending days of each company, the oldest first", async () => {
    const h = harness();

    for (const day of ["2026-11-03", "2026-11-01", "2026-11-02"]) {
      await h.insertMark(ALFA, day);
    }
    await h.insertMark(BETA, "2026-11-09");
    await h.repo.takeDirtyMarks(10);

    expect(await h.repo.listPending([BETA, ALFA], 2)).toEqual([
      { businessId: ALFA, day: "2026-11-01" },
      { businessId: ALFA, day: "2026-11-02" },
      { businessId: BETA, day: "2026-11-09" },
    ]);
    expect(await h.repo.listPending([], 2)).toEqual([]);
  });

  it("settles exactly the pending days it is given, with the counts", async () => {
    const h = harness();

    await h.insertMark(ALFA, "2026-11-01");
    await h.insertMark(ALFA, "2026-11-02");
    await h.repo.takeDirtyMarks(10);

    expect(
      await h.repo.store([
        { businessId: ALFA, units: [], settle: ["2026-11-01", "2026-10-01"] },
      ]),
    ).toEqual({ stored: 0, settled: 1 });
    expect(await h.repo.listPending([ALFA], 10)).toEqual([
      { businessId: ALFA, day: "2026-11-02" },
    ]);
  });

  it("finds the companies that created a delivery inside their probe, the end excluded", async () => {
    const h = harness();

    await h.seedDelivery(ALFA, TO);
    await h.seedDelivery(BETA, FROM);

    expect(
      await h.repo.activeBusinesses([
        { businessId: BETA, from: FROM, to: TO },
        { businessId: ALFA, from: FROM, to: TO },
      ]),
    ).toEqual([BETA]);
    expect(await h.repo.activeBusinesses([])).toEqual([]);
  });

  it("prunes the delivery rows no keep covers, never a pending day nor another company's", async () => {
    const h = harness();
    const unit = (metric: string, day: string) => ({
      metric,
      day,
      from: FROM,
      to: TO,
    });

    await h.repo.store([
      {
        businessId: ALFA,
        units: [
          unit(SP, "2025-10-31"),
          unit(SP, "2025-11-01"),
          unit(MANAUS, "2026-01-01"),
        ],
        settle: [],
      },
      { businessId: BETA, units: [unit(SP, "2025-10-01")], settle: [] },
    ]);
    await h.insertMark(ALFA, "2024-01-01");
    await h.repo.takeDirtyMarks(10);

    expect(
      await h.repo.prune(
        [ALFA],
        [{ businessId: ALFA, metric: SP, from: "2025-11-01" }],
      ),
    ).toBe(2);
    expect(await h.rows(ALFA)).toEqual([
      { metric: SP, day: "2025-11-01", value: 0 },
      { metric: PENDING_DELIVERY_METRIC, day: "2024-01-01", value: 0 },
    ]);
    expect(await h.rows(BETA)).toHaveLength(1);
    expect(await h.repo.prune([], [])).toBe(0);
  });

  it("is past the horizon once every transaction in flight has ended", async () => {
    const { repo } = harness();
    const horizon = await repo.inFlightHorizon();

    // Another file's transaction on the same server may still be open:
    // wait for the state, never for a time.
    await vi.waitFor(
      async () => expect(await repo.settledSince(horizon)).toBe(true),
      { timeout: 30_000, interval: 100 },
    );
  });
}

export { ALFA, BETA, COMPANIES, GAMA, GHOST, tenantDayRollupContract };
export type { PurgeState, TenantDayRollupHarness };
