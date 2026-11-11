import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

/**
 * The address point a delivery can be CREATED with (plan of 02/11/2026, E1).
 *
 * An operation that already knows where its customers are — the panel's
 * form, a "Latitude"/"Longitude" pair in the spreadsheet, two fields in the
 * ERP's POST /integration/v1/deliveries — hands the point over instead of
 * waiting for the geocoder. It is stored as the address point with the
 * source MANUAL: a new enum value (say, IMPORTED) would take two releases
 * (expand/contract), and MANUAL already means what the geofence needs — a
 * point a person vouched for, read as exact (geofence-rules). The geocoder
 * never overwrites it: its queue and its write both skip a delivery that has
 * a point (geocoding-repository).
 *
 * One rule for the three doors, so a body the panel refuses the API refuses
 * too, with the same sentence: both coordinates or neither, inside the box
 * around Brazil the route map's "Fixar no mapa" already uses.
 */

/**
 * A rough box around Brazil (decision 14.7, §4.11). A click outside the
 * country on a route map is almost always a slip of the mouse; on a create,
 * a pair outside it is almost always a swapped one (-46, -23), the usual
 * ERP mistake — and a stop placed in the Atlantic would quietly bend the
 * whole plan line and make every geofence check fail.
 */
const BRAZIL_BOX = { minLat: -34, maxLat: 6, minLng: -74, maxLng: -34 };

function isInsideBrazil(point: {
  latitude: number;
  longitude: number;
}): boolean {
  return (
    point.latitude >= BRAZIL_BOX.minLat &&
    point.latitude <= BRAZIL_BOX.maxLat &&
    point.longitude >= BRAZIL_BOX.minLng &&
    point.longitude <= BRAZIL_BOX.maxLng
  );
}

const SWAPPED_HINT = "Confira se a latitude e a longitude não estão trocadas.";

const ADDRESS_POINT_MESSAGES = {
  latitudeNotNumber: "A latitude deve ser um número.",
  longitudeNotNumber: "A longitude deve ser um número.",
  latitudeRange: `A latitude deve estar entre ${BRAZIL_BOX.minLat} e ${BRAZIL_BOX.maxLat} (o Brasil). ${SWAPPED_HINT}`,
  longitudeRange: `A longitude deve estar entre ${BRAZIL_BOX.minLng} e ${BRAZIL_BOX.maxLng} (o Brasil). ${SWAPPED_HINT}`,
  pair: "Informe a latitude e a longitude juntas, ou nenhuma das duas.",
} as const;

type AddressCoordinate = "latitude" | "longitude";

/**
 * "" (or blanks) and null are an absent coordinate, as on the rest of the
 * create: ERPs serialise an empty column as "", and a form clears a field
 * to "". Never 0: a coerced 0,0 is a point in the Atlantic.
 */
function blankToNull(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

const coordinateField = (
  label: AddressCoordinate,
  min: number,
  max: number,
  description: string,
) =>
  z.preprocess(
    blankToNull,
    z
      .number(
        fieldError({
          invalid:
            label === "latitude"
              ? ADDRESS_POINT_MESSAGES.latitudeNotNumber
              : ADDRESS_POINT_MESSAGES.longitudeNotNumber,
        }),
      )
      .min(
        min,
        label === "latitude"
          ? ADDRESS_POINT_MESSAGES.latitudeRange
          : ADDRESS_POINT_MESSAGES.longitudeRange,
      )
      .max(
        max,
        label === "latitude"
          ? ADDRESS_POINT_MESSAGES.latitudeRange
          : ADDRESS_POINT_MESSAGES.longitudeRange,
      )
      .nullable()
      .optional()
      .describe(description),
  );

const addressLatitudeField = coordinateField(
  "latitude",
  BRAZIL_BOX.minLat,
  BRAZIL_BOX.maxLat,
  "Latitude do endereço em graus decimais (ex.: -23.5505), entre -34 e 6. Opcional; informe junto com `longitude`. Gravada como ponto do endereço com origem MANUAL (`geo_source`): o geocodificador não a substitui e a geocerca a lê como exata. Sem as duas, o Trajetto localiza o endereço sozinho.",
);

const addressLongitudeField = coordinateField(
  "longitude",
  BRAZIL_BOX.minLng,
  BRAZIL_BOX.maxLng,
  "Longitude do endereço em graus decimais (ex.: -46.6333), entre -74 e -34. Opcional; informe junto com `latitude`.",
);

/**
 * What is wrong with a pair, or null when it is a whole point inside Brazil
 * or no point at all. Pure: the spreadsheet parser reads its cells with it,
 * and the schemas' refinement below asks it about the pair.
 */
function addressPointProblem(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): Array<{ field: AddressCoordinate; message: string }> {
  const hasLatitude = latitude !== null && latitude !== undefined;
  const hasLongitude = longitude !== null && longitude !== undefined;

  if (!hasLatitude && !hasLongitude) return [];

  if (!hasLatitude || !hasLongitude) {
    return [
      {
        field: hasLatitude ? "longitude" : "latitude",
        message: ADDRESS_POINT_MESSAGES.pair,
      },
    ];
  }

  const problems: Array<{ field: AddressCoordinate; message: string }> = [];

  if (latitude < BRAZIL_BOX.minLat || latitude > BRAZIL_BOX.maxLat) {
    problems.push({
      field: "latitude",
      message: ADDRESS_POINT_MESSAGES.latitudeRange,
    });
  }

  if (longitude < BRAZIL_BOX.minLng || longitude > BRAZIL_BOX.maxLng) {
    problems.push({
      field: "longitude",
      message: ADDRESS_POINT_MESSAGES.longitudeRange,
    });
  }

  return problems;
}

/**
 * The pair rule, for a schema's superRefine. Only the pair: each field
 * already refused a value that is not a number or is out of the box.
 */
function refineAddressPointPair(
  body: { latitude?: number | null; longitude?: number | null },
  ctx: z.RefinementCtx,
): void {
  const hasLatitude = body.latitude !== null && body.latitude !== undefined;
  const hasLongitude = body.longitude !== null && body.longitude !== undefined;

  if (hasLatitude === hasLongitude) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [hasLatitude ? "longitude" : "latitude"],
    message: ADDRESS_POINT_MESSAGES.pair,
  });
}

/**
 * The columns a create writes for the point it was given: the point, the
 * source MANUAL and when — or nothing, so the row joins the geocoder's queue
 * (latitude and geo_source NULL). Never half a point: the schemas refuse
 * one, and a caller that got past them still stores none. geo_precision
 * stays NULL: it only describes a GEOCODER point.
 */
function manualAddressPoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  now: Date,
):
  | {
      latitude: number;
      longitude: number;
      geo_source: "MANUAL";
      geo_updated_at: Date;
    }
  | Record<string, never> {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return {};
  }

  return { latitude, longitude, geo_source: "MANUAL", geo_updated_at: now };
}

export {
  ADDRESS_POINT_MESSAGES,
  BRAZIL_BOX,
  addressLatitudeField,
  addressLongitudeField,
  addressPointProblem,
  isInsideBrazil,
  manualAddressPoint,
  refineAddressPointPair,
};
export type { AddressCoordinate };
