import { z } from "zod";

/**
 * An optional coordinate from the driver app: a number (or a numeric string
 * from a form body), or nothing.
 *
 * `null` and "" mean "no fix" (a phone without a location). `z.coerce` alone
 * turned them into 0, and the report was drawn at 0,0, a point in the
 * Atlantic. Same rule as the pause schema (modules/driver-pause).
 */
const optionalCoordinate = (limit: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.coerce.number().min(-limit).max(limit).optional(),
  );

export { optionalCoordinate };
