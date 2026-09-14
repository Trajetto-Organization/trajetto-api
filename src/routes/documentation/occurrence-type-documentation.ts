import { z } from "zod";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import { listOccurrenceTypeSchema } from "@/schemas/list-occurrence-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteOccurrenceTypeSchema } from "@/schemas/update-delete-occurrence-type-schema";

const occurrenceTypeEntity = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  requires_photo: z.boolean(),
  blocks_delivery: z.boolean(),
  is_active: z.boolean(),
  businessId: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const occurrenceTypeSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  occurrenceTypeBusinessParams: updateDeleteBusinessSchema.merge(
    updateDeleteOccurrenceTypeSchema,
  ),
  createOccurrenceType: createOccurrenceTypeSchema,
  updateOccurrenceType: updateOccurrenceTypeSchema,
  listOccurrenceTypes: listOccurrenceTypeSchema,
};

const occurrenceTypeResponses = {
  occurrenceTypeCreated: z.object({
    message: z.string().default("Tipo de ocorrência criado com sucesso!"),
  }),
  occurrenceTypeUpdated: z.object({
    message: z.string().default("Tipo de ocorrência atualizado com sucesso!"),
  }),
  occurrenceTypeDeleted: z.object({
    message: z.string().default("Tipo de ocorrência excluído com sucesso!"),
  }),
  occurrenceTypeList: z.object({
    data: z.array(occurrenceTypeEntity),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { occurrenceTypeSchemas, occurrenceTypeResponses };
