import { describe, expect, it } from "vitest";

import {
  LOOKUP_PENDING_MS,
  addressLookupState,
} from "@/shared/delivery/geocoding/address-lookup-state";
import { GEOCODING_MAX_ATTEMPTS } from "@/shared/delivery/geocoding/geocoding-rules";

/**
 * What the route page says about a stop without a point (owner's report of
 * 09/11/2026): "Localizando endereço…" while a lookup is under way or due
 * within moments, "Endereço não localizado" once it is over without a
 * point, and nothing new when there is nothing to wait for. "Fixar no mapa"
 * is open in all of them; the state only says whether waiting is worth it.
 *
 * Review of 09/11/2026: the spinner had no end — a provider refusing every
 * request, a quota spent or a queue that never came kept it for good.
 */
const NOW = new Date("2026-11-09T15:00:00.000Z");

const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const ON = { enabled: true, now: NOW };

/** Created a minute ago, never claimed. */
const OPEN = {
  status: "PENDING",
  latitude: null,
  longitude: null,
  geo_source: null,
  geocode_status: null,
  geocode_attempts: 0,
  geocode_attempted_at: null,
  updated_at: minutesAgo(1),
};

describe("addressLookupState", () => {
  it("says nothing for a stop with a point, or on a server that looks nothing up", () => {
    expect(
      addressLookupState(
        { ...OPEN, latitude: -22.5, longitude: -43.17, geo_source: "GEOCODER" },
        ON,
      ),
    ).toBeNull();
    expect(
      addressLookupState(
        { ...OPEN, latitude: -22.5, longitude: -43.17, geo_source: "MANUAL" },
        ON,
      ),
    ).toBeNull();
    expect(addressLookupState(OPEN, { enabled: false, now: NOW })).toBeNull();
  });

  it("is SEARCHING while a lookup is under way: just written, or just claimed", () => {
    expect(addressLookupState(OPEN, ON)).toBe("SEARCHING");
    expect(addressLookupState({ ...OPEN, status: "IN_TRANSIT" }, ON)).toBe(
      "SEARCHING",
    );

    // An old delivery the lookup after a routing just claimed.
    expect(
      addressLookupState(
        {
          ...OPEN,
          updated_at: minutesAgo(600),
          geocode_attempts: 1,
          geocode_attempted_at: minutesAgo(0),
        },
        ON,
      ),
    ).toBe("SEARCHING");
  });

  it("stops promising once nothing asked about the address for the window", () => {
    // Created half an hour ago and never claimed: something kept the
    // lookup from coming (a queue, a worker down).
    expect(
      addressLookupState({ ...OPEN, updated_at: minutesAgo(30) }, ON),
    ).toBeNull();

    // A claim whose replica died: no answer, and none coming soon.
    expect(
      addressLookupState(
        {
          ...OPEN,
          updated_at: minutesAgo(600),
          geocode_attempts: 1,
          geocode_attempted_at: minutesAgo(LOOKUP_PENDING_MS / 60_000 + 1),
        },
        ON,
      ),
    ).toBeNull();

    // No instant at all: nothing to promise.
    expect(addressLookupState({ ...OPEN, updated_at: null }, ON)).toBeNull();
  });

  it("says nothing while the lookups are held: a refusal, the quota, the budget", () => {
    expect(addressLookupState(OPEN, { ...ON, held: true })).toBeNull();
  });

  it("says nothing after a failure: the next attempt waits out its back-off", () => {
    expect(
      addressLookupState(
        {
          ...OPEN,
          geocode_status: "FAILED",
          geocode_attempts: 2,
          geocode_attempted_at: minutesAgo(0),
        },
        ON,
      ),
    ).toBeNull();
  });

  it("is NOT_LOCATED once it is over without a point", () => {
    for (const geocode_status of ["NOT_FOUND", "COARSE"]) {
      expect(addressLookupState({ ...OPEN, geocode_status }, ON)).toBe(
        "NOT_LOCATED",
      );
    }

    expect(
      addressLookupState(
        {
          ...OPEN,
          geocode_status: "FAILED",
          geocode_attempts: GEOCODING_MAX_ATTEMPTS,
        },
        ON,
      ),
    ).toBe("NOT_LOCATED");
  });

  it("is NOT_LOCATED past the claim's cap even without a status, as the claim never takes it again", () => {
    // Eight claims that wrote nothing: replicas that died, pins made and
    // cleared while the provider was asked.
    expect(
      addressLookupState(
        {
          ...OPEN,
          geocode_attempts: GEOCODING_MAX_ATTEMPTS,
          geocode_attempted_at: minutesAgo(0),
        },
        ON,
      ),
    ).toBe("NOT_LOCATED");
  });

  it("says nothing for a closed delivery, nor after a dispatcher cleared a found point", () => {
    for (const status of ["DELIVERED", "CANCELLED", "FAILED"]) {
      expect(addressLookupState({ ...OPEN, status }, ON)).toBeNull();
    }

    expect(
      addressLookupState({ ...OPEN, geocode_status: "RESOLVED" }, ON),
    ).toBeNull();
  });

  it("reads the instants as the database and the JSON give them", () => {
    expect(
      addressLookupState(
        { ...OPEN, updated_at: minutesAgo(1).toISOString() },
        ON,
      ),
    ).toBe("SEARCHING");
  });
});
