import { describe, expect, it } from "vitest";

import { UF_NAMES, UFS, ufOf } from "@/shared/brazil/uf-names";
import {
  rankSuggestions,
  scopedText,
} from "@/shared/services/address-search/address-search-ranking";

/**
 * The list of "Fixar no mapa"'s search (plan pin-search), from the
 * provider's places: Brazilian only, each once, titled the way the panel
 * writes an address, with the level the point reached, the delivery's city
 * first, and "weak" when nothing bears the name typed.
 */
const PETROPOLIS = { city: "Petrópolis", uf: "RJ" as const };

/** A LocationIQ autocomplete place. */
function place(overrides: Record<string, unknown> = {}) {
  const { address, ...rest } = overrides as {
    address?: Record<string, unknown>;
  };

  return {
    place_id: "1",
    lat: "-22.5084",
    lon: "-43.1735",
    class: "highway",
    type: "residential",
    display_name:
      "Rua Epitácio Pessoa, Centro, Petrópolis, Rio de Janeiro, 25610-000, Brasil",
    address: {
      name: "Rua Epitácio Pessoa",
      road: "Rua Epitácio Pessoa",
      suburb: "Centro",
      city: "Petrópolis",
      state: "Rio de Janeiro",
      postcode: "25610-000",
      country: "Brasil",
      country_code: "br",
      ...address,
    },
    ...rest,
  };
}

const rank = (
  places: Array<Record<string, unknown>>,
  query = "Rua Epitácio Pessoa, 120",
  hint: typeof PETROPOLIS | null = PETROPOLIS,
) => rankSuggestions(places, { query, hint, viewbox: null, limit: 8 });

describe("the text the provider searches", () => {
  it("adds the delivery's city and state, unless the city is already typed", () => {
    expect(scopedText("Rua Epitácio Pessoa, 120", PETROPOLIS)).toBe(
      "Rua Epitácio Pessoa, 120, Petrópolis, Rio de Janeiro",
    );
    expect(scopedText("Rua Epitácio Pessoa petropolis", PETROPOLIS)).toBe(
      "Rua Epitácio Pessoa petropolis",
    );
    expect(scopedText("Rua Epitácio Pessoa", null)).toBe("Rua Epitácio Pessoa");
  });

  it("never passes the provider's 200 characters: the state goes first, then the city", () => {
    const withState = "x".repeat(200 - ", Petrópolis, Rio de Janeiro".length);
    const withCity = "x".repeat(200 - ", Petrópolis".length);

    expect(scopedText(withState, PETROPOLIS)).toHaveLength(200);
    expect(scopedText(withState, PETROPOLIS)).toBe(
      `${withState}, Petrópolis, Rio de Janeiro`,
    );
    expect(scopedText(`${withState}y`, PETROPOLIS)).toBe(
      `${withState}y, Petrópolis`,
    );
    expect(scopedText(withCity, PETROPOLIS)).toBe(`${withCity}, Petrópolis`);
    expect(scopedText(`${withCity}y`, PETROPOLIS)).toBe(`${withCity}y`);
    expect(scopedText("x".repeat(200), PETROPOLIS)).toHaveLength(200);

    // The delivery's city of 100 characters, the most it can have.
    const city = { ...PETROPOLIS, city: "C".repeat(100) };

    for (const length of [3, 50, 95, 96, 150, 200]) {
      expect(scopedText("q".repeat(length), city).length).toBeLessThanOrEqual(
        200,
      );
    }
  });

  it("knows the 27 UFs both ways", () => {
    expect(UFS).toHaveLength(27);
    expect(ufOf("Rio de Janeiro")).toBe("RJ");
    expect(ufOf("sao paulo")).toBe("SP");
    expect(ufOf("BR-MG")).toBe("MG");
    expect(ufOf("Estado do Paraná")).toBe("PR");
    expect(ufOf("df")).toBe("DF");
    expect(ufOf("Buenos Aires")).toBeNull();
    expect(UF_NAMES.RJ).toBe("Rio de Janeiro");
  });
});

describe("one suggestion", () => {
  it("titles a door 'street, number' and the rest of the address after it", () => {
    const { results } = rank([
      place({
        class: "place",
        type: "house",
        address: { house_number: "120" },
      }),
    ]);

    expect(results).toEqual([
      {
        id: "1",
        title: "Rua Epitácio Pessoa, 120",
        subtitle: "Centro, Petrópolis - RJ, 25610-000",
        latitude: -22.5084,
        longitude: -43.1735,
        precision: "ADDRESS",
        city: "Petrópolis",
        uf: "RJ",
        bbox: null,
        inScope: true,
      },
    ]);
  });

  it("names a place by its name, with its street in the subtitle (PLACE)", () => {
    const { results } = rank(
      [
        place({
          class: "amenity",
          type: "hospital",
          display_place: "Hospital Santa Teresa",
          address: {
            name: "Hospital Santa Teresa",
            road: "Rua Dom Pedro I",
            house_number: "1",
          },
        }),
      ],
      "Hospital Santa Teresa",
    );

    expect(results[0]).toMatchObject({
      title: "Hospital Santa Teresa",
      subtitle: "Rua Dom Pedro I, 1, Centro, Petrópolis - RJ, 25610-000",
      precision: "PLACE",
    });
  });

  it("reads a street without a number as STREET, and a CEP's eight digits with the hyphen", () => {
    const { results } = rank([place({ address: { postcode: "25610000" } })]);

    expect(results[0]).toMatchObject({
      title: "Rua Epitácio Pessoa",
      subtitle: "Centro, Petrópolis - RJ, 25610-000",
      precision: "STREET",
    });
  });

  it("frames a district or a city with its box, never as a door", () => {
    const { results } = rank(
      [
        place({
          place_id: "d",
          class: "place",
          type: "suburb",
          boundingbox: ["-22.52", "-22.49", "-43.19", "-43.16"],
          address: { road: undefined, name: "Centro" },
        }),
        place({
          place_id: "c",
          class: "boundary",
          type: "administrative",
          lat: "-22.505",
          lon: "-43.178",
          boundingbox: ["-22.6", "-22.2", "-43.3", "-42.9"],
          address: { road: undefined, suburb: undefined, name: "Petrópolis" },
        }),
      ],
      "Centro Petrópolis",
    );

    expect(
      results.map(({ id, precision, title, subtitle, bbox }) => ({
        id,
        precision,
        title,
        subtitle,
        bbox,
      })),
    ).toEqual([
      {
        id: "d",
        precision: "NEIGHBORHOOD",
        title: "Centro",
        subtitle: "Petrópolis - RJ, 25610-000",
        bbox: [-22.52, -22.49, -43.19, -43.16],
      },
      {
        id: "c",
        precision: "CITY",
        title: "Petrópolis",
        subtitle: "Rio de Janeiro, 25610-000",
        bbox: [-22.6, -22.2, -43.3, -42.9],
      },
    ]);
  });
});

describe("the list", () => {
  it("drops what is outside Brazil, an invalid point and (0, 0)", () => {
    const { results } = rank([
      place({ place_id: "ar", address: { country_code: "ar" } }),
      place({ place_id: "lisboa", lat: "38.72", lon: "-9.14" }),
      place({ place_id: "nan", lat: "x" }),
      place({ place_id: "zero", lat: "0", lon: "0" }),
      place({ place_id: "ok" }),
    ]);

    expect(results.map((result) => result.id)).toEqual(["ok"]);
  });

  it("shows a place once: the same title in the same city, or within 30 m", () => {
    const { results } = rank([
      place({ place_id: "a" }),
      place({ place_id: "b", lat: "-22.5300" }),
      // No city to key on, a metre away: the same door.
      place({
        place_id: "c",
        lat: "-22.50841",
        address: { city: undefined },
      }),
    ]);

    expect(results.map((result) => result.id)).toEqual(["a"]);
  });

  it("puts the delivery's city before another 'Rua São José', and the number typed first", () => {
    const sao = (
      id: string,
      city: string,
      state: string,
      lat: string,
      extra = {},
    ) =>
      place({
        place_id: id,
        lat,
        display_name: `Rua São José, ${city}`,
        address: {
          name: "Rua São José",
          road: "Rua São José",
          city,
          state,
          suburb: id,
          ...extra,
        },
      });

    const { results } = rank(
      [
        sao("sp", "São Paulo", "São Paulo", "-23.55"),
        sao("ter", "Teresópolis", "Rio de Janeiro", "-22.41"),
        sao("petro", "Petrópolis", "Rio de Janeiro", "-22.50"),
        sao("petro-12", "Petrópolis", "Rio de Janeiro", "-22.51", {
          house_number: "12",
        }),
      ],
      "Rua São José 12",
    );

    expect(results.map((result) => [result.id, result.inScope])).toEqual([
      ["petro-12", true],
      ["petro", true],
      ["ter", false],
      ["sp", false],
    ]);
  });

  it("keeps the provider's order between equals", () => {
    const { results } = rank(
      [
        place({ place_id: "1", address: { suburb: "A" }, lat: "-22.51" }),
        place({ place_id: "2", address: { suburb: "B" }, lat: "-22.52" }),
        place({ place_id: "3", address: { suburb: "C" }, lat: "-22.53" }),
      ].map((entry, index) => ({
        ...entry,
        display_name: `Rua ${index}`,
        address: { ...entry.address, road: `Rua Epitácio Pessoa ${index}` },
      })),
    );

    expect(results.map((result) => result.id)).toEqual(["1", "2", "3"]);
  });

  it("leans toward the stops' box between equals", () => {
    const near = place({
      place_id: "near",
      lat: "-22.51",
      lon: "-43.17",
      address: { suburb: "Perto" },
    });
    const far = place({
      place_id: "far",
      lat: "-22.30",
      lon: "-43.10",
      address: { road: "Travessa Epitácio Pessoa", suburb: "Longe" },
    });

    const { results } = rankSuggestions([far, near], {
      query: "Rua Epitácio Pessoa",
      hint: PETROPOLIS,
      viewbox: [-43.2, -22.55, -43.15, -22.48],
      limit: 8,
    });

    expect(results.map((result) => result.id)).toEqual(["near", "far"]);
  });

  it("is weak when nothing bears the name typed ('Curitba'), and never for a number alone", () => {
    const boaVista = place({
      display_name: "Rua Curitiba, Boa Vista, Roraima",
      address: {
        name: "Rua Curitiba",
        road: "Rua Curitiba",
        suburb: "Centro",
        city: "Boa Vista",
        state: "Roraima",
      },
    });

    expect(rank([boaVista], "Curitba", null).weak).toBe(true);
    expect(rank([boaVista], "Rua Curitiba", null).weak).toBe(false);
    expect(rank([boaVista], "120", null).weak).toBe(false);
    expect(rank([], "Curitba", null)).toEqual({ results: [], weak: false });
  });

  it("shows at most the limit asked", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      place({
        place_id: String(index),
        lat: String(-22.5 - index / 100),
        address: { road: `Rua Epitácio Pessoa ${index}`, suburb: `B${index}` },
      }),
    );

    expect(
      rankSuggestions(many, {
        query: "Rua Epitácio Pessoa",
        hint: PETROPOLIS,
        viewbox: null,
        limit: 3,
      }).results,
    ).toHaveLength(3);
  });
});
