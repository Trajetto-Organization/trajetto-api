import type { OccurrenceType } from "../dtos/occurrence-type-dto";
import type { OccurrenceFormField } from "../form/occurrence-form-rules";
import { readFormFields } from "../form/occurrence-form-rules";
import type { CategoryShape } from "../rules/occurrence-category-rules";

/**
 * The matrix's view of a type: the stored row with the requested changes on
 * top (undefined keeps the stored value). `form` is the normalized form the
 * write would store, or undefined to keep the row's.
 */
type Loose<T> = { [K in keyof T]?: T[K] | null };

function categoryShapeOf(
  current: Loose<OccurrenceType>,
  changes: Loose<OccurrenceType>,
  form: OccurrenceFormField[] | null | undefined,
): CategoryShape {
  const pick = <K extends keyof OccurrenceType>(key: K) =>
    changes[key] !== undefined ? changes[key] : current[key];

  const fields =
    form !== undefined ? form : readFormFields(current.form_fields);

  return {
    category: pick("category") ?? "NOT_DELIVERED",
    requires_photo: pick("requires_photo") === true,
    requires_receipt_photo: pick("requires_receipt_photo") === true,
    requires_signature: pick("requires_signature") === true,
    requires_authorization: pick("requires_authorization") === true,
    blocks_delivery: pick("blocks_delivery") === true,
    pause_kind: pick("pause_kind") ?? null,
    has_form: (fields?.length ?? 0) > 0,
  };
}

export { categoryShapeOf };
