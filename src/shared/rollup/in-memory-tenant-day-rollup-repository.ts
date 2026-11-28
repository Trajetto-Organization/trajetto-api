import {
  DELIVERY_METRIC_PREFIX,
  PENDING_DELIVERY_METRIC,
} from "./tenant-day-rules";
import type {
  ITenantDayRollupRepository,
  RollupActivityProbe,
  RollupBusiness,
  RollupCoverageRow,
  RollupGroup,
  RollupKeep,
  RollupMetricKey,
  RollupPendingDay,
} from "./tenant-day-rollup-repository";

type PurgeState = "SCHEDULED" | "PURGING" | "PURGED" | null;

interface StoredDay {
  businessId: string;
  metric: string;
  day: string;
  value: number;
}

/**
 * The rollup's twin (tests/contract/repositories/tenant-day-rollup.contract.ts
 * holds both to the same expectations): the companies, their deliveries'
 * created_at, the marks and tenant_day_count, as the rows the tests seed.
 * One process and no transaction in flight, so the wait for the
 * transactions in flight is always over.
 */
class InMemoryTenantDayRollupRepository implements ITenantDayRollupRepository {
  public businesses = new Map<
    string,
    { timezone: string | null; purgeState: PurgeState }
  >();

  public deliveries: Array<{ businessId: string; created_at: Date }> = [];

  public marks: Array<{ id: number; businessId: string; day: string }> = [];

  public days = new Map<string, StoredDay>();

  private nextMarkId = 1;

  private static key(businessId: string, metric: string, day: string): string {
    return `${businessId}\u0000${metric}\u0000${day}`;
  }

  /** A mark as the trigger of F4-20 writes it: none while one is there. */
  markDay(businessId: string, day: string): void {
    const marked = this.marks.some(
      (mark) => mark.businessId === businessId && mark.day === day,
    );

    if (!marked) this.insertMark(businessId, day);
  }

  /** A mark as written: two writers at once may leave the same day twice. */
  insertMark(businessId: string, day: string): void {
    this.marks.push({ id: this.nextMarkId++, businessId, day });
  }

  private counted(businessId: string): boolean {
    const business = this.businesses.get(businessId);

    return (
      business !== undefined &&
      (business.purgeState === null || business.purgeState === "SCHEDULED")
    );
  }

  async listBusinesses(): Promise<RollupBusiness[]> {
    return [...this.businesses.entries()]
      .filter(([id]) => this.counted(id))
      .map(([id, business]) => ({ id, timezone: business.timezone }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async takeDirtyMarks(
    limit: number,
  ): Promise<{ taken: number; added: number }> {
    const taken = [...this.marks]
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.max(0, limit));
    const takenIds = new Set(taken.map((mark) => mark.id));

    this.marks = this.marks.filter((mark) => !takenIds.has(mark.id));

    let added = 0;

    for (const mark of taken) {
      if (!this.counted(mark.businessId)) continue;

      const key = InMemoryTenantDayRollupRepository.key(
        mark.businessId,
        PENDING_DELIVERY_METRIC,
        mark.day,
      );

      if (!this.days.has(key)) {
        this.days.set(key, {
          businessId: mark.businessId,
          metric: PENDING_DELIVERY_METRIC,
          day: mark.day,
          value: 0,
        });
        added += 1;
      }
    }

    return { taken: taken.length, added };
  }

  async listPending(
    businessIds: readonly string[],
    perBusiness: number,
  ): Promise<RollupPendingDay[]> {
    return [...new Set(businessIds)].sort().flatMap((businessId) =>
      [...this.days.values()]
        .filter(
          (row) =>
            row.businessId === businessId &&
            row.metric === PENDING_DELIVERY_METRIC,
        )
        .map((row) => row.day)
        .sort()
        .slice(0, Math.max(0, perBusiness))
        .map((day) => ({ businessId, day })),
    );
  }

  async inFlightHorizon(): Promise<string> {
    return "0";
  }

  async settledSince(): Promise<boolean> {
    return true;
  }

  async coverage(
    keys: readonly RollupMetricKey[],
  ): Promise<RollupCoverageRow[]> {
    return keys
      .map((key) => {
        const days = [...this.days.values()]
          .filter(
            (row) =>
              row.businessId === key.businessId && row.metric === key.metric,
          )
          .map((row) => row.day)
          .sort();

        return {
          businessId: key.businessId,
          metric: key.metric,
          first: days[0] ?? null,
          last: days[days.length - 1] ?? null,
        };
      })
      .sort((a, b) =>
        a.businessId !== b.businessId
          ? a.businessId < b.businessId
            ? -1
            : 1
          : a.metric < b.metric
            ? -1
            : a.metric > b.metric
              ? 1
              : 0,
      );
  }

  private countIn(businessId: string, from: Date, to: Date): number {
    return this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.created_at >= from &&
        delivery.created_at < to,
    ).length;
  }

  async activeBusinesses(
    probes: readonly RollupActivityProbe[],
  ): Promise<string[]> {
    return probes
      .filter(
        (probe) => this.countIn(probe.businessId, probe.from, probe.to) > 0,
      )
      .map((probe) => probe.businessId)
      .sort();
  }

  async store(
    groups: readonly RollupGroup[],
  ): Promise<{ stored: number; settled: number }> {
    let stored = 0;
    let settled = 0;

    for (const group of groups) {
      if (this.counted(group.businessId)) {
        for (const unit of group.units) {
          this.days.set(
            InMemoryTenantDayRollupRepository.key(
              group.businessId,
              unit.metric,
              unit.day,
            ),
            {
              businessId: group.businessId,
              metric: unit.metric,
              day: unit.day,
              value: this.countIn(group.businessId, unit.from, unit.to),
            },
          );
          stored += 1;
        }
      }

      for (const day of group.settle) {
        const key = InMemoryTenantDayRollupRepository.key(
          group.businessId,
          PENDING_DELIVERY_METRIC,
          day,
        );

        if (this.days.delete(key)) settled += 1;
      }
    }

    return { stored, settled };
  }

  async prune(
    businessIds: readonly string[],
    keep: readonly RollupKeep[],
  ): Promise<number> {
    const companies = new Set(businessIds);
    let deleted = 0;

    for (const [key, row] of this.days) {
      if (!companies.has(row.businessId)) continue;
      if (!row.metric.startsWith(DELIVERY_METRIC_PREFIX)) continue;

      const kept = keep.some(
        (entry) =>
          entry.businessId === row.businessId &&
          entry.metric === row.metric &&
          row.day >= entry.from,
      );

      if (!kept) {
        this.days.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }
}

export { InMemoryTenantDayRollupRepository };
