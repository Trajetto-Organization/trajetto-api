import type {
  GeocodingClaim,
  GeocodingSettlement,
  IDeliveryGeocodingRepository,
  OpenStopRoute,
} from "./geocoding-repository";
import {
  GEOCODING_MAX_ATTEMPTS,
  geocodingBackoffMinutes,
} from "./geocoding-rules";

/** The delivery columns the geocoding queue reads and writes. */
interface GeocodingRow {
  id: string;
  businessId: string;
  street: string | null;
  address_number: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  cep: string | null;
  status: string;
  latitude: number | null;
  longitude: number | null;
  geo_source: string | null;
  geo_precision: string | null;
  geo_updated_at: Date | null;
  geocode_status: string | null;
  geocode_attempted_at: Date | null;
  geocode_attempts: number;
  created_at: Date;
}

/**
 * The twin of DeliveryGeocodingRepository: the same queue, claim order,
 * back-off, settle and release guards over rows the tests seed. One
 * process, so the SKIP LOCKED half has nothing to model; the lease does.
 * The routes holding the deliveries are seeded apart (`stopRoutes`): this
 * twin knows no route table.
 */
class InMemoryDeliveryGeocodingRepository implements IDeliveryGeocodingRepository {
  public deliveries: GeocodingRow[] = [];

  /** The open stops of unfinished routes, as openStopRoutes answers them. */
  public stopRoutes: OpenStopRoute[] = [];

  async claim(limit: number, now: Date): Promise<GeocodingClaim[]> {
    return this.claimWhere(() => true, limit, now);
  }

  async claimOpenStops(limit: number, now: Date): Promise<GeocodingClaim[]> {
    if (limit <= 0) return [];

    return this.claimWhere(
      (row) => this.stopRoutes.some((stop) => stop.deliveryId === row.id),
      limit,
      now,
    );
  }

  async claimByIds(
    ids: readonly string[],
    businessId: string,
    limit: number,
    now: Date,
  ): Promise<GeocodingClaim[]> {
    if (ids.length === 0 || limit <= 0) return [];

    return this.claimWhere(
      (row) => ids.includes(row.id) && row.businessId === businessId,
      limit,
      now,
    );
  }

  private claimWhere(
    scope: (row: GeocodingRow) => boolean,
    limit: number,
    now: Date,
  ): GeocodingClaim[] {
    const claimable = (row: GeocodingRow) =>
      row.latitude === null &&
      row.geo_source === null &&
      (row.geocode_status === null || row.geocode_status === "FAILED") &&
      (row.status === "PENDING" || row.status === "IN_TRANSIT") &&
      row.geocode_attempts < GEOCODING_MAX_ATTEMPTS &&
      (row.geocode_attempted_at === null ||
        row.geocode_attempted_at.getTime() <
          now.getTime() -
            geocodingBackoffMinutes(row.geocode_attempts) * 60_000) &&
      scope(row);

    const picked = this.deliveries
      .filter(claimable)
      .sort(
        (a, b) =>
          b.created_at.getTime() - a.created_at.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, limit);

    return picked.map((row) => {
      const previousAttemptedAt = row.geocode_attempted_at
        ? new Date(row.geocode_attempted_at.getTime())
        : null;

      row.geocode_attempted_at = new Date(now.getTime());
      row.geocode_attempts += 1;

      return {
        id: row.id,
        businessId: row.businessId,
        street: row.street,
        address_number: row.address_number,
        neighborhood: row.neighborhood,
        city: row.city,
        uf: row.uf,
        cep: row.cep,
        claimedAt: new Date(now.getTime()),
        attempts: row.geocode_attempts,
        previousAttemptedAt,
      };
    });
  }

  /** The row the claim still holds, or undefined. */
  private held(claim: GeocodingClaim): GeocodingRow | undefined {
    return this.deliveries.find(
      (entry) =>
        entry.id === claim.id &&
        entry.geocode_attempted_at?.getTime() === claim.claimedAt.getTime(),
    );
  }

  async settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean> {
    const row = this.held(claim);

    if (!row || row.latitude !== null || row.geo_source !== null) return false;

    switch (settlement.kind) {
      case "RESOLVED":
        Object.assign(row, {
          latitude: settlement.latitude,
          longitude: settlement.longitude,
          geo_source: "GEOCODER",
          geo_updated_at: new Date(now.getTime()),
          geo_precision: settlement.precision,
          geocode_status: "RESOLVED",
        });
        break;
      case "COARSE":
        Object.assign(row, {
          geo_precision: settlement.precision,
          geocode_status: "COARSE",
        });
        break;
      case "NOT_FOUND":
      case "FAILED":
        row.geocode_status = settlement.kind;
        break;
    }

    return true;
  }

  async release(claim: GeocodingClaim): Promise<boolean> {
    const row = this.held(claim);

    if (!row) return false;

    row.geocode_attempted_at = claim.previousAttemptedAt
      ? new Date(claim.previousAttemptedAt.getTime())
      : null;
    row.geocode_attempts = Math.max(row.geocode_attempts - 1, 0);

    return true;
  }

  async openStopRoutes(
    deliveryIds: readonly string[],
  ): Promise<OpenStopRoute[]> {
    return this.stopRoutes
      .filter((stop) => deliveryIds.includes(stop.deliveryId))
      .map((stop) => ({ ...stop }));
  }
}

export { InMemoryDeliveryGeocodingRepository };
export type { GeocodingRow };
