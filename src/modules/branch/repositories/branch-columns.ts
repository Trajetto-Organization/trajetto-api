/**
 * The optional text columns of a branch, as the table stores them: a blank
 * value is NULL, never "". The forms send "" for an empty field, and a ""
 * trade name counted as "Com nome fantasia" on the cards.
 *
 * Only the keys the caller sent are normalised: a partial update must not
 * turn an absent key into NULL (that erased the ERP code and the complement
 * on every PATCH that omitted them). Shared by the repository and its twin.
 */
const OPTIONAL_TEXT_COLUMNS = ["fantasy_name", "complement", "erp_code"] as const;

type OptionalTextColumn = (typeof OPTIONAL_TEXT_COLUMNS)[number];

function blankOptionalsToNull(
  data: object,
): Partial<Record<OptionalTextColumn, string | null>> {
  const normalised: Partial<Record<OptionalTextColumn, string | null>> = {};
  const record = data as Partial<Record<string, unknown>>;

  for (const column of OPTIONAL_TEXT_COLUMNS) {
    if (!(column in record) || record[column] === undefined) continue;

    const value = record[column];

    normalised[column] =
      typeof value === "string" && value.trim() !== "" ? value : null;
  }

  return normalised;
}

export { OPTIONAL_TEXT_COLUMNS, blankOptionalsToNull };
