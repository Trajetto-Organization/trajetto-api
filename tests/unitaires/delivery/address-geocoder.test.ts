import { describe, expect, it } from "vitest";

import {
  addressQuery,
  geocodeAddress,
  parseNominatimSearch,
  searchUrl,
  type AddressGeocoderConfig,
} from "@/shared/services/proof-location/address-geocoder";

/**
 * The forward lookup of a delivery's address (plan of 02/11/2026, E1;
 * decision D15): the reverse geocoder's sibling, against the same
 * Nominatim-compatible provider (LocationIQ). Three answers and nothing
 * else: a point with the level it reached, "no such address", or "the
 * provider failed" — which the job retries, while the other two settle the
 * address. Never throws, never logs the URL (it carries the key).
 */
const CONFIG: AddressGeocoderConfig = {
  url: "https://us1.locationiq.com/v1/",
  key: "chave-de-teste",
  keyParam: "key",
  userAgent: "Trajetto/1.0 (+https://app.example)",
  timeoutMs: 3_000,
};

const ADDRESS = {
  street: "Praça da Sé",
  address_number: "100",
  neighborhood: "Sé",
  city: "São Paulo",
  uf: "SP",
  cep: "01001-000",
};

function fetcherAnswering(status: number, body: unknown, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);

    return { status, json: async () => body };
  };
}

describe("addressQuery", () => {
  it("writes the address as one line, in the order a Brazilian reads it", () => {
    expect(addressQuery(ADDRESS)).toBe(
      "Praça da Sé, 100, Sé, São Paulo - SP, 01001-000, Brasil",
    );
  });

  it("leaves out what the address does not have", () => {
    expect(
      addressQuery({
        street: "Rua das Flores",
        address_number: null,
        neighborhood: "  ",
        city: "Recife",
        uf: "PE",
        cep: null,
      }),
    ).toBe("Rua das Flores, Recife - PE, Brasil");
  });
});

describe("searchUrl", () => {
  it("asks /search for one result in Brazil, in Portuguese, with the key", () => {
    const url = new URL(searchUrl(CONFIG, ADDRESS));

    expect(url.origin + url.pathname).toBe(
      "https://us1.locationiq.com/v1/search",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: addressQuery(ADDRESS),
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
      countrycodes: "br",
      "accept-language": "pt-BR",
      key: "chave-de-teste",
    });
  });
});

describe("parseNominatimSearch", () => {
  const hit = (overrides: Record<string, unknown>) => [
    {
      lat: "-23.5503",
      lon: "-46.6340",
      class: "place",
      type: "house",
      address: { road: "Praça da Sé", house_number: "100", city: "São Paulo" },
      ...overrides,
    },
  ];

  it("reads the house number as the address itself", () => {
    expect(parseNominatimSearch(hit({}))).toEqual({
      latitude: -23.5503,
      longitude: -46.634,
      precision: "ADDRESS",
    });
  });

  it("reads a street without the number as the street", () => {
    expect(
      parseNominatimSearch(
        hit({
          class: "highway",
          type: "residential",
          address: { road: "Praça da Sé", city: "São Paulo" },
        }),
      ),
    ).toMatchObject({ precision: "STREET" });
  });

  it("reads a district or a city as coarse", () => {
    expect(
      parseNominatimSearch(
        hit({
          class: "place",
          type: "suburb",
          address: { suburb: "Sé", city: "São Paulo" },
        }),
      ),
    ).toMatchObject({ precision: "NEIGHBORHOOD" });
    expect(
      parseNominatimSearch(
        hit({
          class: "boundary",
          type: "administrative",
          address: { city: "São Paulo" },
        }),
      ),
    ).toMatchObject({ precision: "CITY" });
  });

  it("trusts Nominatim's own rank when it sends one", () => {
    expect(
      parseNominatimSearch(hit({ place_rank: 30, address: {} })),
    ).toMatchObject({ precision: "ADDRESS" });
    expect(
      parseNominatimSearch(hit({ place_rank: 26, address: {} })),
    ).toMatchObject({ precision: "STREET" });
    expect(
      parseNominatimSearch(hit({ place_rank: 20, address: {} })),
    ).toMatchObject({ precision: "NEIGHBORHOOD" });
    expect(
      parseNominatimSearch(hit({ place_rank: 16, address: {} })),
    ).toMatchObject({ precision: "CITY" });
  });

  it("answers nothing for no result or an unusable point", () => {
    expect(parseNominatimSearch([])).toBeNull();
    expect(parseNominatimSearch({ error: "Unable to geocode" })).toBeNull();
    expect(parseNominatimSearch(hit({ lat: "abc" }))).toBeNull();
    expect(parseNominatimSearch(hit({ lat: "0", lon: "0" }))).toBeNull();
  });
});

describe("geocodeAddress", () => {
  it("answers the point and its level", async () => {
    const seen: string[] = [];

    await expect(
      geocodeAddress(
        ADDRESS,
        CONFIG,
        fetcherAnswering(
          200,
          [
            {
              lat: "-23.5503",
              lon: "-46.6340",
              class: "place",
              type: "house",
              address: { house_number: "100", road: "Praça da Sé" },
            },
          ],
          seen,
        ),
      ),
    ).resolves.toEqual({
      kind: "FOUND",
      latitude: -23.5503,
      longitude: -46.634,
      precision: "ADDRESS",
    });
    expect(seen).toHaveLength(1);
  });

  it("answers NOT_FOUND for an empty answer and for LocationIQ's 404", async () => {
    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(200, [])),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(
      geocodeAddress(
        ADDRESS,
        CONFIG,
        fetcherAnswering(404, { error: "Unable to geocode" }),
      ),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
  });

  it("answers FAILED for a refusal, an outage or a timeout, to be tried again", async () => {
    for (const status of [401, 429, 500, 503]) {
      await expect(
        geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(status, {})),
      ).resolves.toEqual({ kind: "FAILED", status });
    }

    await expect(
      geocodeAddress(ADDRESS, CONFIG, async () => {
        throw new Error("The operation was aborted due to timeout");
      }),
    ).resolves.toEqual({ kind: "FAILED", status: null });
  });

  it("does not ask about an address without a street or a city", async () => {
    const seen: string[] = [];

    await expect(
      geocodeAddress(
        { ...ADDRESS, street: "  " },
        CONFIG,
        fetcherAnswering(200, [], seen),
      ),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
    expect(seen).toEqual([]);
  });

  it("does nothing with the provider switched off", async () => {
    await expect(
      geocodeAddress(ADDRESS, { ...CONFIG, url: undefined }),
    ).resolves.toEqual({ kind: "DISABLED" });
  });
});
