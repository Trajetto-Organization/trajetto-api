import { z } from "zod";
import {
  occurrenceTypeNameSchema,
  occurrenceTypeDescriptionSchema,
} from "@/schemas/create-occurrence-type-schema";

const updateOccurrenceTypeSchema = z.object({
  name: occurrenceTypeNameSchema.optional(),
  description: occurrenceTypeDescriptionSchema,
  requires_photo: z.boolean().optional(),
  blocks_delivery: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export { updateOccurrenceTypeSchema };
