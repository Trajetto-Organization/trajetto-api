import { describe, expect, it } from "vitest";

import {
  addressQuery,
  foldText,
  formatCep,
  geocodeAddress,
  hasFallbackQuery,
  houseNumber,
  parseNominatimSearch,
  parseStructuredSearch,
  searchUrl,
  structuredSearchUrl,
  type AddressGeocoderConfig,
} from "@/shared/services/proof-location/address-geocoder";

/**
 * The forward lookup of a delivery's address (plan of 02/11/2026, E1;
 * decision D15): the reverse geocoder's sibling, against the same
 * Nominatim-compatible provider (LocationIQ). A point with the level it
 * reached, or "no such address" — the two answers about the ADDRESS, which
 * settle it — and three about the provider, which the job never charges to
 * the delivery: refused (configuration), rate-limited (429), failed (try
 * again). Never throws, never logs the URL (it carries the key).
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
  // As every door stores it: eight digits.
  cep: "01001000",
};

function fetcherAnswering(status: number, body: unknown, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);

    return { status, json: async () => body };
  };
}

/** A body that is not JSON: an HTML error page, a web site's 200. */
function fetcherAnsweringHtml(status: number) {
  return async () => ({
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  });
}

describe("addressQuery", () => {
  it("writes the address as one line, in the order a Brazilian reads it", () => {
    expect(addressQuery(ADDRESS)).toBe(
      "Praça da Sé, 100, Sé, São Paulo - SP, 01001-000, Brasil",
    );
  });

  it("writes the stored eight-digit CEP the way the map does", () => {
    // The owner's example (09/11/2026), as the form stored it.
    expect(
      addressQuery({
        street: "Rua Epitácio Pessoa",
        address_number: null,
        neighborhood: null,
        city: "Petrópolis",
        uf: "RJ",
        cep: "25610000",
      }),
    ).toBe("Rua Epitácio Pessoa, Petrópolis - RJ, 25610-000, Brasil");
  });

  it("leaves out a number that says there is none", () => {
    for (const none of ["S/N", "s/n", "SN", "s/nº", "Sem número", "0", "000"]) {
      expect(addressQuery({ ...ADDRESS, address_number: none })).toBe(
        "Praça da Sé, Sé, São Paulo - SP, 01001-000, Brasil",
      );
    }
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

describe("formatCep and houseNumber", () => {
  it("hyphenates eight digits and keeps anything else as it came", () => {
    expect(formatCep("25610000")).toBe("25610-000");
    expect(formatCep("25610-000")).toBe("25610-000");
    expect(formatCep(" 2561000 ")).toBe("2561000");
    expect(formatCep("  ")).toBeNull();
    expect(formatCep(null)).toBeNull();
  });

  it("keeps a real number, a block or a kilometre", () => {
    expect(houseNumber("100")).toBe("100");
    expect(houseNumber("12A")).toBe("12A");
    expect(houseNumber("km 12")).toBe("km 12");
    expect(houseNumber("S/N")).toBeNull();
    expect(houseNumber(null)).toBeNull();
  });
});

describe("hasFallbackQuery", () => {
  it("is worth a second call only when the line carried more than street, city and UF", () => {
    expect(hasFallbackQuery(ADDRESS)).toBe(true);
    expect(hasFallbackQuery({ ...ADDRESS, address_number: null })).toBe(true);
    expect(
      hasFallbackQuery({
        street: "Rua das Flores",
        address_number: "s/n",
        neighborhood: " ",
        city: "Recife",
        uf: "PE",
        cep: null,
      }),
    ).toBe(false);
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
      format: "json",
      addressdetails: "1",
      limit: "1",
      countrycodes: "br",
      "accept-language": "pt-BR",
      key: "chave-de-teste",
    });
  });

  it("asks the fallback as street, city and UF alone, structured, five results to see the street named twice", () => {
    const url = new URL(structuredSearchUrl(CONFIG, ADDRESS));

    expect(url.origin + url.pathname).toBe(
      "https://us1.locationiq.com/v1/search",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      street: "Praça da Sé",
      city: "São Paulo",
      state: "SP",
      country: "Brasil",
      format: "json",
      addressdetails: "1",
      limit: "5",
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

  it("reads jsonv2's `category` as the class when there is no rank", () => {
    expect(
      parseNominatimSearch([
        {
          lat: "-22.5084144",
          lon: "-43.1735186",
          category: "highway",
          type: "footway",
          address: { city: "Petrópolis" },
        },
      ]),
    ).toMatchObject({ precision: "STREET" });
    expect(
      parseNominatimSearch([
        {
          lat: "-22.5084144",
          lon: "-43.1735186",
          category: "building",
          type: "yes",
          address: { city: "Petrópolis" },
        },
      ]),
    ).toMatchObject({ precision: "ADDRESS" });
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

describe("parseStructuredSearch", () => {
  // The structured search for the owner's example, as OpenStreetMap's
  // Nominatim answered it: the street, then two other streets of the city.
  const OWNER_ANSWER = [
    {
      osm_id: 991605642,
      lat: "-22.5084144",
      lon: "-43.1735186",
      category: "highway",
      type: "residential",
      place_rank: 26,
      address: {
        road: "Rua Epitácio Pessoa",
        suburb: "Centro",
        city: "Petrópolis",
        state: "Rio de Janeiro",
        postcode: "25610-010",
        country: "Brasil",
      },
    },
    {
      lat: "-22.4163078",
      lon: "-43.1340022",
      category: "highway",
      type: "residential",
      place_rank: 26,
      address: {
        road: "Rua Amazonas",
        suburb: "Nogueira",
        postcode: "25730-203",
      },
    },
    {
      lat: "-22.4157170",
      lon: "-43.1330670",
      category: "highway",
      type: "residential",
      place_rank: 26,
      address: { road: "Rua Piauí", suburb: "Nogueira" },
    },
  ];

  it("reads the first result and what it says about its place", () => {
    expect(parseStructuredSearch(OWNER_ANSWER)).toEqual({
      latitude: -22.5084144,
      longitude: -43.1735186,
      precision: "STREET",
      place: {
        road: "Rua Epitácio Pessoa",
        districts: ["Centro"],
        postcode: "25610010",
        repeated: false,
      },
    });
  });

  it("says the street repeats when another result names it far away", () => {
    const twice = [
      OWNER_ANSWER[0],
      {
        ...OWNER_ANSWER[1],
        address: { road: "Rua Epitácio Pessoa", suburb: "Nogueira" },
      },
    ];

    expect(parseStructuredSearch(twice)?.place.repeated).toBe(true);

    // The same street a few metres on: one street, not two.
    const near = [
      OWNER_ANSWER[0],
      { ...OWNER_ANSWER[0], lat: "-22.5086", lon: "-43.1736" },
    ];

    expect(parseStructuredSearch(near)?.place.repeated).toBe(false);
  });

  it("answers nothing for no result", () => {
    expect(parseStructuredSearch([])).toBeNull();
    expect(parseStructuredSearch({ error: "Unable to geocode" })).toBeNull();
  });

  it("folds a name the way it is compared", () => {
    expect(foldText("  Rua Epitácio  Pessoa, 12 ")).toBe(
      "rua epitacio pessoa 12",
    );
    expect(foldText(null)).toBe("");
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
    expect(new URL(seen[0]).searchParams.get("q")).toContain("01001-000");
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

  it("answers REFUSED for a request the provider will never take: key, parameters, URL", async () => {
    for (const status of [400, 401, 403]) {
      await expect(
        geocodeAddress(
          ADDRESS,
          CONFIG,
          fetcherAnswering(status, { error: "Invalid key" }),
        ),
      ).resolves.toEqual({ kind: "REFUSED", status });
    }

    // A REVERSE_GEOCODER_URL off by a segment: a 404 page, not "not found".
    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnsweringHtml(404)),
    ).resolves.toEqual({ kind: "REFUSED", status: 404 });
    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(404, [])),
    ).resolves.toEqual({ kind: "REFUSED", status: 404 });

    // A web site's home page answering 200 to /search.
    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnsweringHtml(200)),
    ).resolves.toEqual({ kind: "REFUSED", status: 200 });
  });

  it("answers RATE_LIMITED for a 429, telling the day's quota from a burst", async () => {
    await expect(
      geocodeAddress(
        ADDRESS,
        CONFIG,
        fetcherAnswering(429, { error: "Rate Limited Day" }),
      ),
    ).resolves.toEqual({ kind: "RATE_LIMITED", status: 429, scope: "DAY" });

    for (const body of [{ error: "Rate Limited Second" }, {}]) {
      await expect(
        geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(429, body)),
      ).resolves.toEqual({ kind: "RATE_LIMITED", status: 429, scope: "SHORT" });
    }

    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnsweringHtml(429)),
    ).resolves.toEqual({ kind: "RATE_LIMITED", status: 429, scope: "SHORT" });
  });

  it("answers FAILED for an outage or a timeout, to be tried again", async () => {
    for (const status of [408, 500, 502, 503]) {
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

  it("asks the structured fallback when told to", async () => {
    const seen: string[] = [];

    await geocodeAddress(
      ADDRESS,
      CONFIG,
      fetcherAnswering(200, [], seen),
      "STRUCTURED",
    );

    expect(new URL(seen[0]).searchParams.get("street")).toBe("Praça da Sé");
    expect(new URL(seen[0]).searchParams.has("q")).toBe(false);
  });

  it("answers the structured result with its place, the free text without", async () => {
    const body = [
      {
        lat: "-23.5503",
        lon: "-46.6340",
        class: "highway",
        type: "pedestrian",
        address: { road: "Praça da Sé", suburb: "Sé", postcode: "01001-000" },
      },
    ];

    await expect(
      geocodeAddress(
        ADDRESS,
        CONFIG,
        fetcherAnswering(200, body),
        "STRUCTURED",
      ),
    ).resolves.toEqual({
      kind: "FOUND",
      latitude: -23.5503,
      longitude: -46.634,
      precision: "STREET",
      place: {
        road: "Praça da Sé",
        districts: ["Sé"],
        postcode: "01001000",
        repeated: false,
      },
    });
    await expect(
      geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(200, body)),
    ).resolves.not.toHaveProperty("place");
  });

  it("never puts the URL, which carries the key, in what it answers", async () => {
    const outcomes = await Promise.all([
      geocodeAddress(ADDRESS, CONFIG, fetcherAnswering(401, {})),
      geocodeAddress(ADDRESS, CONFIG, fetcherAnsweringHtml(404)),
      geocodeAddress(ADDRESS, CONFIG, async () => {
        throw new Error(`fetch failed: ${searchUrl(CONFIG, ADDRESS)}`);
      }),
    ]);

    expect(JSON.stringify(outcomes)).not.toContain("chave-de-teste");
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
