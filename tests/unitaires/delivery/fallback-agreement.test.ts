import { describe, expect, it } from "vitest";

import {
  DISTRICT_RADIUS_M,
  districtAgrees,
  fallbackAgrees,
  postcodeAgrees,
  sameStreet,
} from "@/shared/delivery/geocoding/fallback-agreement";
import type { GeocodeOutcome } from "@/shared/services/proof-location/address-geocoder";

/**
 * Whether the fallback's answer (street, city and UF alone) may stand for
 * the delivery (review of 09/11/2026): it drops the district, the CEP and
 * the number, exactly what told two streets of one name apart. A point in
 * the wrong district is worse than none — the geofence measures from it.
 */
const OWNER = {
  street: "Rua Epitácio Pessoa",
  address_number: null,
  neighborhood: null,
  city: "Petrópolis",
  uf: "RJ",
  cep: "25610000",
};

// What the structured search answered on OpenStreetMap for the owner's
// example (way 991605642).
const EPITACIO: GeocodeOutcome = {
  kind: "FOUND",
  latitude: -22.5084144,
  longitude: -43.1735186,
  precision: "STREET",
  place: {
    road: "Rua Epitácio Pessoa",
    districts: ["Centro"],
    postcode: "25610010",
    repeated: false,
  },
};

const found = (
  place: Partial<
    NonNullable<Extract<GeocodeOutcome, { kind: "FOUND" }>["place"]>
  >,
  point: Partial<Record<"latitude" | "longitude", number>> = {},
): GeocodeOutcome => ({
  ...(EPITACIO as Extract<GeocodeOutcome, { kind: "FOUND" }>),
  ...point,
  place: {
    ...(EPITACIO as Extract<GeocodeOutcome, { kind: "FOUND" }>).place!,
    ...place,
  },
});

describe("fallbackAgrees", () => {
  it("lets the owner's street stand", () => {
    expect(fallbackAgrees(OWNER, { kind: "NOT_FOUND" }, EPITACIO)).toBe(true);
    expect(
      fallbackAgrees(
        { ...OWNER, neighborhood: "Centro", cep: "25610010" },
        { kind: "NOT_FOUND" },
        EPITACIO,
      ),
    ).toBe(true);
  });

  it("refuses another street the search answered, and a street the city has twice", () => {
    expect(
      fallbackAgrees(
        OWNER,
        { kind: "NOT_FOUND" },
        found({ road: "Rua Amazonas" }),
      ),
    ).toBe(false);
    expect(
      fallbackAgrees(OWNER, { kind: "NOT_FOUND" }, found({ repeated: true })),
    ).toBe(false);
    expect(
      fallbackAgrees(OWNER, { kind: "NOT_FOUND" }, found({ road: null })),
    ).toBe(false);
  });

  it("refuses a street in another district, or with another region's CEP", () => {
    expect(
      fallbackAgrees(
        { ...OWNER, neighborhood: "Quitandinha" },
        { kind: "NOT_FOUND" },
        EPITACIO,
      ),
    ).toBe(false);
    expect(
      fallbackAgrees(
        { ...OWNER, cep: "25685010" },
        { kind: "NOT_FOUND" },
        EPITACIO,
      ),
    ).toBe(false);
  });

  it("refuses a street far from the district the full address reached", () => {
    const district: GeocodeOutcome = {
      kind: "FOUND",
      latitude: -22.52,
      longitude: -43.18,
      precision: "NEIGHBORHOOD",
    };

    expect(fallbackAgrees(OWNER, district, EPITACIO)).toBe(true);
    expect(
      fallbackAgrees(
        OWNER,
        district,
        found({}, { latitude: -22.4163078, longitude: -43.1340022 }),
      ),
    ).toBe(false);
    expect(DISTRICT_RADIUS_M).toBe(3_000);
  });

  it("never weighs an answer without a point, nor one with nothing to say", () => {
    expect(
      fallbackAgrees(
        { ...OWNER, neighborhood: "Quitandinha" },
        { kind: "NOT_FOUND" },
        {
          kind: "FOUND",
          latitude: -22.5,
          longitude: -43.17,
          precision: "NEIGHBORHOOD",
        },
      ),
    ).toBe(true);
    expect(
      fallbackAgrees(OWNER, { kind: "NOT_FOUND" }, { kind: "NOT_FOUND" }),
    ).toBe(true);

    // A point without what the structured search says about it: unchecked,
    // so it does not stand.
    expect(
      fallbackAgrees(OWNER, { kind: "NOT_FOUND" }, {
        ...EPITACIO,
        place: undefined,
      } as GeocodeOutcome),
    ).toBe(false);
  });
});

describe("sameStreet", () => {
  it("reads past accents, case, the street's kind and a shortened title", () => {
    expect(sameStreet("rua epitacio pessoa", "Rua Epitácio Pessoa")).toBe(true);
    expect(sameStreet("R. Epitácio Pessoa", "Rua Epitácio Pessoa")).toBe(true);
    expect(sameStreet("Av. Dr. Arnaldo", "Avenida Doutor Arnaldo")).toBe(true);
    expect(sameStreet("Rua João Pessoa", "Rua Presidente João Pessoa")).toBe(
      true,
    );
  });

  it("tells two streets apart", () => {
    expect(sameStreet("Rua Epitácio Pessoa", "Rua Amazonas")).toBe(false);
    expect(sameStreet("Rua 1", "Rua 10")).toBe(false);
    expect(sameStreet("Rua São José", "Rua José")).toBe(false);
    expect(sameStreet("", "Rua Amazonas")).toBe(false);
  });
});

describe("districtAgrees and postcodeAgrees", () => {
  it("compares the district only when both name one", () => {
    expect(districtAgrees("Centro", ["Centro"])).toBe(true);
    expect(districtAgrees("centro histórico", ["Centro"])).toBe(true);
    expect(districtAgrees("Quitandinha", ["Centro"])).toBe(false);
    expect(districtAgrees(null, ["Centro"])).toBe(true);
    expect(districtAgrees("Centro", [])).toBe(true);
  });

  it("compares the first five digits, never a general CEP", () => {
    expect(postcodeAgrees("25610010", "25610010")).toBe(true);
    expect(postcodeAgrees("25610020", "25610010")).toBe(true);
    expect(postcodeAgrees("25685010", "25610010")).toBe(false);
    expect(postcodeAgrees("25610000", "25685010")).toBe(true);
    expect(postcodeAgrees("25610010", null)).toBe(true);
    expect(postcodeAgrees(null, "25610010")).toBe(true);
  });
});
