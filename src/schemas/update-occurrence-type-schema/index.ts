import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import {
  occurrenceTypeNameSchema,
  occurrenceTypeDescriptionSchema,
  occurrenceTypeFormFieldsSchema,
  occurrenceCategorySchema,
  pauseKindSchema,
} from "@/schemas/create-occurrence-type-schema";

const updateOccurrenceTypeSchema = z.object({
  ...tenantLockedShape,
  name: occurrenceTypeNameSchema.optional(),
  description: occurrenceTypeDescriptionSchema,
  requires_photo: z.boolean().optional(),
  blocks_delivery: z.boolean().optional(),
  is_active: z.boolean().optional(),
  requires_authorization: z
    .boolean()
    .optional()
    .describe(
      "Liga ou desliga a autorização da torre. Relatos já pendentes continuam pendentes até a decisão.",
    ),
  // Absent keeps the form; null or [] removes it. A different form moves
  // form_version by one.
  form_fields: occurrenceTypeFormFieldsSchema,
  // Decision 14.3. The combination is checked against the current type in
  // the use case (400 VALIDATION_ERROR); a used or default type keeps its
  // category and nature (409 OCCURRENCE_TYPE_CATEGORY_LOCKED).
  category: occurrenceCategorySchema.optional(),
  requires_receipt_photo: z.boolean().optional(),
  requires_signature: z.boolean().optional(),
  pause_kind: pauseKindSchema.optional(),
});

export { updateOccurrenceTypeSchema };
