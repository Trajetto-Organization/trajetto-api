import { describe, expect, it } from "vitest";

import {
  createDeliveryBodySchema,
  createDeliverySchema,
} from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";
import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";
import { parseDeliverySpreadsheet } from "@/shared/delivery/spreadsheet-parser";
import {
  BRAZIL_BOX,
  isInsideBrazil,
  manualAddressPoint,
} from "@/shared/delivery/address-coordinates";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { isInsideBrazil as pinIsInsideBrazil } from "@/modules/route/usecases/set-delivery-location/set-delivery-location-usecase";

/**
 * Plan of 02/11/2026, E1: the coordinates an operation already has — typed
 * on the panel's form, a column of the spreadsheet, a field of the ERP's
 * POST — are accepted on the create and stored as the address point, with
 * the source MANUAL (a new enum value would take two releases). The
 * geocoder then never touches the row (its queue and its write both skip a
 * delivery that has a point), and the geofence reads a MANUAL point as
 * exact.
 *
 * One rule for the three doors: both coordinates or neither, inside the box
 * the route map's "Fixar no mapa" already uses for Brazil — a swapped pair
 * (-46, -23) is the usual ERP mistake, and it lands in the Atlantic.
 */
const PANEL_BODY = {
  shipperId: "018f6000-0000-7000-8000-0000000000f1",
  recipient_name: "Padaria Central",
  cep: "01001-000",
  city: "São Paulo",
  uf: "SP",
  street: "Praça da Sé",
  scheduled_date: "2026-11-03",
};

const INTEGRATION_BODY = {
  shipper_id: "018f6000-0000-7000-8000-0000000000f1",
  recipient_name: "Padaria Central",
  cep: "01001000",
  city: "São Paulo",
  uf: "SP",
  street: "Praça da Sé",
};

const SE = { latitude: -23.5505, longitude: -46.6333 };

const messagesOf = (result: { success: boolean; error?: unknown }) =>
  result.success
    ? []
    : (
        result.error as { issues: Array<{ message: string; path: unknown[] }> }
      ).issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

describe("the panel's create form", () => {
  it("takes a point inside Brazil", () => {
    const parsed = createDeliveryBodySchema.parse({ ...PANEL_BODY, ...SE });

    expect(parsed).toMatchObject(SE);
  });

  it("reads an empty or null coordinate as no point at all", () => {
    const parsed = createDeliveryBodySchema.parse({
      ...PANEL_BODY,
      latitude: "",
      longitude: null,
    });

    expect(parsed.latitude ?? null).toBeNull();
    expect(parsed.longitude ?? null).toBeNull();
  });

  it("refuses half a point, naming the coordinate that is missing", () => {
    const result = createDeliveryBodySchema.safeParse({
      ...PANEL_BODY,
      latitude: SE.latitude,
    });

    expect(messagesOf(result)).toEqual([
      "longitude: Informe a latitude e a longitude juntas, ou nenhuma das duas.",
    ]);
  });

  it("refuses a point outside Brazil, which is how a swapped pair arrives", () => {
    const result = createDeliveryBodySchema.safeParse({
      ...PANEL_BODY,
      latitude: SE.longitude,
      longitude: SE.latitude,
    });

    expect(messagesOf(result)).toEqual([
      "latitude: A latitude deve estar entre -34 e 6 (o Brasil). Confira se a latitude e a longitude não estão trocadas.",
      "longitude: A longitude deve estar entre -74 e -34 (o Brasil). Confira se a latitude e a longitude não estão trocadas.",
    ]);
  });

  it("refuses a coordinate that is not a number", () => {
    const result = createDeliveryBodySchema.safeParse({
      ...PANEL_BODY,
      latitude: "-23,55",
      longitude: SE.longitude,
    });

    expect(messagesOf(result)).toEqual([
      "latitude: A latitude deve ser um número.",
    ]);
  });

  it("keeps the shape the integration and the edit derive from", () => {
    // The public create and the edit are built from the field object, so
    // the coordinates must be fields of it, not something only the body
    // schema's refinement knows.
    expect(Object.keys(createDeliverySchema.shape)).toEqual(
      expect.arrayContaining(["latitude", "longitude"]),
    );
  });
});

describe("the edit", () => {
  it("does not take a point: moving the pin is the route map's 'Fixar no mapa'", () => {
    const parsed = updateDeliverySchema.parse({ city: "Campinas", ...SE });

    expect(parsed).not.toHaveProperty("latitude");
    expect(parsed).not.toHaveProperty("longitude");
  });
});

describe("the public create", () => {
  it("takes a point with the same rule", () => {
    expect(
      parseIntegrationDeliveryBody({ ...INTEGRATION_BODY, ...SE }),
    ).toMatchObject(SE);
  });

  it("refuses half a point with the field in front of the sentence", () => {
    expect(() =>
      parseIntegrationDeliveryBody({
        ...INTEGRATION_BODY,
        longitude: SE.longitude,
      }),
    ).toThrow(
      "latitude: Informe a latitude e a longitude juntas, ou nenhuma das duas.",
    );
  });

  it("reads an empty column as no point, as ERPs serialise one", () => {
    const parsed = parseIntegrationDeliveryBody({
      ...INTEGRATION_BODY,
      latitude: "",
      longitude: "",
    });

    expect(parsed.latitude ?? null).toBeNull();
    expect(parsed.longitude ?? null).toBeNull();
  });
});

describe("the spreadsheet", () => {
  const HEADER = [
    "Destinatário",
    "CEP",
    "Cidade",
    "UF",
    "Logradouro",
    "Latitude",
    "Longitude",
  ];
  const ADDRESS = ["Padaria Central", "01001000", "São Paulo", "SP", "Sé"];

  it("reads the two columns, with the comma a Brazilian sheet writes", () => {
    const result = parseDeliverySpreadsheet([
      HEADER,
      [...ADDRESS, "-23,5505", "-46.6333"],
      [...ADDRESS, -22.9068, -43.1729],
      [...ADDRESS, "", ""],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => [row.latitude, row.longitude])).toEqual([
      [-23.5505, -46.6333],
      [-22.9068, -43.1729],
      [null, null],
    ]);
  });

  it("accepts the short spellings an ERP export uses", () => {
    const result = parseDeliverySpreadsheet([
      ["Destinatário", "CEP", "Cidade", "UF", "Logradouro", "lat", "lng"],
      [...ADDRESS, "-23.5505", "-46.6333"],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject(SE);
  });

  it("refuses the row, not the file, for half a point or one outside Brazil", () => {
    const result = parseDeliverySpreadsheet([
      HEADER,
      [...ADDRESS, "-23,5505", ""],
      [...ADDRESS, "-46,6333", "-23,5505"],
      [...ADDRESS, "abc", "-46,6333"],
      [...ADDRESS, "-23,5505", "-46,6333"],
    ]);

    expect(result.rows.map((row) => row.line)).toEqual([5]);
    expect(result.errors).toEqual([
      {
        line: 2,
        column: "Longitude",
        message:
          "Informe a latitude e a longitude juntas, ou nenhuma das duas.",
      },
      {
        line: 3,
        column: "Latitude",
        message:
          "A latitude deve estar entre -34 e 6 (o Brasil). Confira se a latitude e a longitude não estão trocadas.",
      },
      {
        line: 3,
        column: "Longitude",
        message:
          "A longitude deve estar entre -74 e -34 (o Brasil). Confira se a latitude e a longitude não estão trocadas.",
      },
      {
        line: 4,
        column: "Latitude",
        message: "A latitude deve ser um número.",
      },
    ]);
  });
});

describe("the columns the create writes", () => {
  const NOW = new Date("2026-11-03T15:00:00.000Z");

  it("are the point, MANUAL and when, for a whole pair", () => {
    expect(manualAddressPoint(SE.latitude, SE.longitude, NOW)).toEqual({
      ...SE,
      geo_source: "MANUAL",
      geo_updated_at: NOW,
    });
  });

  it("are nothing without a whole pair: the geocoder's queue keeps the row", () => {
    expect(manualAddressPoint(null, null, NOW)).toEqual({});
    expect(manualAddressPoint(undefined, undefined, NOW)).toEqual({});
    expect(manualAddressPoint(SE.latitude, null, NOW)).toEqual({});
  });

  it("are written by the twin like the table", async () => {
    const repository = new InMemoryDeliveryRepository();
    const base = {
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: "b1",
      shipperId: "s1",
    };

    const pinned = await repository.createDelivery({ ...base, ...SE });
    // Another door: at the same one it would take the pin (below).
    const plain = await repository.createDelivery({
      ...base,
      street: "Rua das Coletas",
    });

    expect(pinned).toMatchObject({
      ...SE,
      geo_source: "MANUAL",
      geo_precision: null,
      geocode_status: null,
    });
    expect(pinned.geo_updated_at).toBeInstanceOf(Date);
    expect(plain).toMatchObject({
      latitude: null,
      longitude: null,
      geo_source: null,
      geo_updated_at: null,
    });
  });
});

describe("the point of another delivery at the same door", () => {
  // Owner's report of 14/11/2026: a delivery at an address the company had
  // already located read "Sem localização". The create, the one door of
  // the panel, the XML, the spreadsheet and the public API, takes the
  // point another delivery of the company has at the same address.
  const LIPOLD = {
    recipient_name: "Destinatário",
    street: "Rua Doutor Lipold",
    address_number: "10",
    neighborhood: "Carangola",
    city: "Petrópolis",
    uf: "RJ",
    businessId: "b1",
    shipperId: "s1",
  };
  const PIN = { latitude: -22.4561, longitude: -43.1702 };

  it("is taken without coordinates, written as GEOCODER at the number", async () => {
    const repository = new InMemoryDeliveryRepository();

    const first = await repository.createDelivery({ ...LIPOLD, ...PIN });
    const second = await repository.createDelivery({
      ...LIPOLD,
      street: "R. Dr. Lipold",
      cep: "25715000",
    });

    expect(first.address_key).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatchObject({
      ...PIN,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
      address_key: first.address_key,
    });
    expect(second.geo_updated_at).toBeInstanceOf(Date);
  });

  it("is never another company's", async () => {
    const repository = new InMemoryDeliveryRepository();

    await repository.createDelivery({ ...LIPOLD, ...PIN });
    const elsewhere = await repository.createDelivery({
      ...LIPOLD,
      businessId: "b2",
    });

    expect(elsewhere).toMatchObject({ latitude: null, geo_source: null });
  });

  it("never replaces the point the body brings, which stays MANUAL", async () => {
    const repository = new InMemoryDeliveryRepository();
    const own = { latitude: -22.4565, longitude: -43.1705 };

    await repository.createDelivery({ ...LIPOLD, ...PIN });
    const given = await repository.createDelivery({ ...LIPOLD, ...own });

    expect(given).toMatchObject({ ...own, geo_source: "MANUAL" });
  });

  it("is not taken at a neighbour's number, nor without a street", async () => {
    const repository = new InMemoryDeliveryRepository();

    await repository.createDelivery({ ...LIPOLD, ...PIN });

    expect(
      await repository.createDelivery({ ...LIPOLD, address_number: "12" }),
    ).toMatchObject({ latitude: null });
    expect(
      await repository.createDelivery({ ...LIPOLD, street: "" }),
    ).toMatchObject({ latitude: null, address_key: null });
  });
});

describe("the box", () => {
  it("is the one the route map's pin already uses", () => {
    expect(BRAZIL_BOX).toEqual({
      minLat: -34,
      maxLat: 6,
      minLng: -74,
      maxLng: -34,
    });
    expect(pinIsInsideBrazil).toBe(isInsideBrazil);
    expect(isInsideBrazil(SE)).toBe(true);
    expect(isInsideBrazil({ latitude: -46.6, longitude: -23.5 })).toBe(false);
  });
});
