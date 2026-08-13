/**
 * Coerces a form field to the type the schemas expect.
 *
 * Multipart has no types — every field arrives as a string, so `"true"` had to
 * be turned into `true` before validation. JSON does have types, but clients
 * are not consistent about using them: a form that used to build a FormData
 * tends to keep sending `"true"` and `"120.5"` after it switches to JSON.
 *
 * Running both branches through the same normalisation means a checklist
 * validates identically whichever way it was encoded, instead of the JSON path
 * quietly failing on a boolean that arrived as a string.
 */
function normalizeFormField(fieldName: string, value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;

  if (fieldName === "current_mileage" && typeof value === "string") {
    return parseFloat(value.replace(/\./g, "").replace(",", "."));
  }

  return value;
}

function normalizeFormFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      normalizeFormField(key, value),
    ]),
  );
}

export { normalizeFormField, normalizeFormFields };
