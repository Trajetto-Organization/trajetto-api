import {
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_MAX_ATTEMPTS,
  type GeocodingClaim,
  type GeocodingSettlement,
  type IDeliveryGeocodingRepository,
} from "./geocoding-repository";

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
 * back-off and settle guards over rows the tests seed. One process, so the
 * SKIP LOCKED half has nothing to model; the lease does.
 */
class InMemoryDeliveryGeocodingRepository
  implements IDeliveryGeocodingRepository
{
  public deliveries: GeocodingRow[] = [];

  async claim(limit: number, now: Date): Promise<GeocodingClaim[]> {
    const claimable = (row: GeocodingRow) =>
      row.latitude === null &&
      row.geo_source === null &&
      (row.geocode_status === null || row.geocode_status === "FAILED") &&
      (row.status === "PENDING" || row.status === "IN_TRANSIT") &&
      row.geocode_attempts < GEOCODING_MAX_ATTEMPTS &&
      (row.geocode_attempted_at === null ||
        row.geocode_attempted_at.getTime() <
          now.getTime() -
            GEOCODING_BACKOFF_MINUTES * row.geocode_attempts * 60_000);

    const picked = this.deliveries
      .filter(claimable)
      .sort(
        (a, b) =>
          b.created_at.getTime() - a.created_at.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, limit);

    return picked.map((row) => {
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
      };
    });
  }

  async settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean> {
    const row = this.deliveries.find(
      (entry) =>
        entry.id === claim.id &&
        entry.geocode_attempted_at?.getTime() === claim.claimedAt.getTime() &&
        entry.latitude === null &&
        entry.geo_source === null,
    );

    if (!row) return false;

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
}

export { InMemoryDeliveryGeocodingRepository };
export type { GeocodingRow };
