import {
  routeOfPing,
  type AcceptedPing,
} from "@/shared/route/driver-position-rules";

import type {
  IDriverPositionRepository,
  LivePosition,
  RecordedBatch,
  StoredPosition,
} from "../IDriver-position-repository";

interface StoredRow extends StoredPosition {
  businessId: string;
}

/**
 * The twin of `DriverPositionRepository` (TWR-10).
 *
 * Same semantics as the tables: (driverId, recorded_at) is unique and a
 * resend is absorbed, the last position only moves forward in device time,
 * the trail window is half-open, and every read is locked to the company.
 * Partitions are the one thing it cannot stand in for — that stays in the
 * E2E suite, where Postgres refuses a row with no partition.
 */
class InMemoryDriverPositionRepository implements IDriverPositionRepository {
  public trail: StoredRow[] = [];

  public last = new Map<string, StoredRow>();

  /** What the map's join reads: names, and the plate through the route. */
  public drivers: Array<{ id: string; businessId: string; name: string }> = [];

  public routes: Array<{
    id: string;
    code: number;
    vehiclePlate: string | null;
  }> = [];

  async recordBatch({
    driverId,
    businessId,
    routeId,
    routeStartedAt = null,
    pings,
  }: {
    driverId: string;
    businessId: string;
    routeId: string | null;
    routeStartedAt?: Date | null;
    pings: AcceptedPing[];
  }): Promise<RecordedBatch> {
    if (pings.length === 0) return { stored: 0, dropped: 0 };

    const route = routeId ? { id: routeId, started_at: routeStartedAt } : null;

    let stored = 0;

    for (const ping of pings) {
      const duplicate = this.trail.some(
        (row) =>
          row.driverId === driverId &&
          row.recorded_at.getTime() === ping.recorded_at.getTime(),
      );

      if (duplicate) continue;

      this.trail.push({
        driverId,
        businessId,
        routeId: routeOfPing(ping.recorded_at, route),
        latitude: ping.latitude,
        longitude: ping.longitude,
        accuracy: ping.accuracy,
        speed: ping.speed,
        heading: ping.heading,
        battery: ping.battery,
        recorded_at: ping.recorded_at,
      });

      stored += 1;
    }

    const latest = pings.reduce((newest, ping) =>
      ping.recorded_at > newest.recorded_at ? ping : newest,
    );

    const current = this.last.get(driverId);

    // ON CONFLICT ... WHERE stored < incoming: never backwards.
    if (
      !current ||
      current.recorded_at.getTime() < latest.recorded_at.getTime()
    ) {
      this.last.set(driverId, {
        driverId,
        businessId,
        routeId: routeOfPing(latest.recorded_at, route),
        latitude: latest.latitude,
        longitude: latest.longitude,
        accuracy: latest.accuracy,
        speed: latest.speed,
        heading: latest.heading,
        battery: latest.battery,
        recorded_at: latest.recorded_at,
      });
    }

    return { stored, dropped: 0 };
  }

  async listLatestByBusiness(
    businessId: string,
    since: Date,
  ): Promise<LivePosition[]> {
    return [...this.last.values()]
      .filter(
        (row) =>
          row.businessId === businessId &&
          row.recorded_at.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())
      .map(({ businessId: _businessId, ...row }) => {
        const route = this.routes.find(
          (candidate) => candidate.id === row.routeId,
        );

        return {
          ...row,
          driverName:
            this.drivers.find((driver) => driver.id === row.driverId)?.name ??
            null,
          vehiclePlate: route?.vehiclePlate ?? null,
          routeCode: route?.code ?? null,
        };
      });
  }

  async listLastSignals(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ driverId: string; recorded_at: Date }>> {
    return [...this.last.values()]
      .filter(
        (row) =>
          row.businessId === businessId && driverIds.includes(row.driverId),
      )
      .map((row) => ({ driverId: row.driverId, recorded_at: row.recorded_at }));
  }

  async listTrail({
    businessId,
    driverId,
    from,
    to,
    routeId,
  }: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;
    routeId?: string;
  }): Promise<StoredPosition[]> {
    return this.trail
      .filter(
        (row) =>
          row.businessId === businessId &&
          row.driverId === driverId &&
          (!routeId || row.routeId === routeId) &&
          row.recorded_at.getTime() >= from.getTime() &&
          row.recorded_at.getTime() < to.getTime(),
      )
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime())
      .map(({ businessId: _businessId, ...row }) => row);
  }

  async findLast(
    businessId: string,
    driverId: string,
  ): Promise<StoredPosition | null> {
    const row = this.last.get(driverId);

    if (!row || row.businessId !== businessId) return null;

    const { businessId: _businessId, ...position } = row;

    return position;
  }

  async hasDriver(businessId: string, driverId: string): Promise<boolean> {
    return this.drivers.some(
      (driver) => driver.id === driverId && driver.businessId === businessId,
    );
  }
}

export { InMemoryDriverPositionRepository };
