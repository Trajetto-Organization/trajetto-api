import { z } from "zod";

/**
 * A record of at most `max` entries, counted before any of them is parsed.
 *
 * zod 4 refuses a list past a LEADING `.max()` before reading an element
 * (GHSA-mrhx-c7xc-m3w5), but has no such stop for a record: every key and
 * every value is parsed, and each refused one is an issue the error handler
 * answers and logs. A count in a `.refine()` comes after all of that — a
 * 1 MiB body of `{"k":{}}` entries was 110 thousand issues and 175 MB of
 * heap. The count runs in a preprocess instead, the first stage of a pipe,
 * which stops there; the document still shows the record itself.
 */
function boundedRecord<T extends z.ZodType>(
  max: number,
  message: string,
  record: T,
) {
  return z.preprocess((value, ctx) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > max
    ) {
      ctx.addIssue({ code: "custom", message });

      return z.NEVER;
    }

    return value;
  }, record);
}

export { boundedRecord };
