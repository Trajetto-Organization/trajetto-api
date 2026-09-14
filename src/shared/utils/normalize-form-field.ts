/**
 * Coerces a form field to the type the schemas expect.
 *
 * JSON carries types, but the clients are not consistent about using them: the
 * web forms are built on FormData and read every input as a string, so a
 * checkbox still arrives as `"true"` and a mileage as `"120,5"`. Normalising
 * here keeps that from failing validation on a boolean that is a string.
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

export { normalizeFormFields };
