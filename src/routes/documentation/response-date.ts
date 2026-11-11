import { z } from "zod";

/**
 * The Date half of a response's date (responseDateTime).
 *
 * A handler holds a Date or an ISO string; the wire always carries the
 * string. zod 4 has no JSON Schema for a Date: the type provider writes
 * `string (date-time)` for a lone one, but a union used twice in one schema
 * lost its Date branch, and the field was published as a bare string. The
 * metadata says it once, where zod reads it.
 */
function responseDate() {
  return z.date().meta({ type: "string", format: "date-time" });
}

/**
 * A date in a response: the ISO string on the wire, or the Date a handler
 * holds. A new one per field, as `z.string()` is (`.nullable()`,
 * `.describe()` and the rest chain on it).
 */
function responseDateTime() {
  return z.union([z.string(), responseDate()]);
}

export { responseDate, responseDateTime };
