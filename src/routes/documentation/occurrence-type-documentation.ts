import { z } from "zod";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import { listOccurrenceTypeSchema } from "@/schemas/list-occurrence-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteOccurrenceTypeSchema } from "@/schemas/update-delete-occurrence-type-schema";
import { occurrenceFormFieldsDoc } from "@/modules/occurrence-type/form/occurrence-form-documentation";

const occurrenceTypeEntity = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  requires_photo: z.boolean(),
  blocks_delivery: z.boolean(),
  is_active: z.boolean(),
  is_system: z
    .boolean()
    .describe(
      "Tipo da plataforma ('Comprovante rejeitado'): não editável, nunca oferecido ao motorista.",
    ),
  requires_authorization: z
    .boolean()
    .describe("O relato do motorista espera a decisão da torre (decisão 6.3)."),
  form_fields: occurrenceFormFieldsDoc,
  form_version: z
    .number()
    .describe(
      "Sobe a cada mudança do formulário; cada resposta guarda a versão validada.",
    ),
  category: z
    .enum(["DELIVERED", "NOT_DELIVERED", "PAUSE"])
    .describe("Categoria (decisão 14.3): entrega, não entrega ou pausa."),
  requires_receipt_photo: z.boolean().describe("Exige a foto do canhoto."),
  requires_signature: z.boolean().describe("Exige a assinatura na tela."),
  pause_kind: z
    .enum(["MEAL", "REST", "OTHER"])
    .nullable()
    .describe("Só em PAUSE: a natureza legal (Lei 13.103)."),
  deactivated_at: z
    .string()
    .nullable()
    .describe("Quando foi desativado pela última vez; nulo enquanto ativo."),
  is_default: z
    .boolean()
    .describe(
      "Tipo padrão semeado pela plataforma: editável e desativável, nunca excluível.",
    ),
  in_use: z
    .boolean()
    .describe(
      "Já citado por ocorrência ou pausa: a categoria e a natureza ficam travadas.",
    ),
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
  // Not found (caller or company): 404 with a code (decision 11.3).
  lookupNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  occurrenceTypeNotFound: z
    .object({
      code: z
        .string()
        .describe(
          "OCCURRENCE_TYPE_NOT_FOUND (o tipo de ocorrência não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
        ),
      message: z.string(),
    })
    .describe(
      "OCCURRENCE_TYPE_NOT_FOUND (o tipo de ocorrência não existe ou é de outra empresa — a mesma resposta), USER_NOT_FOUND (o usuário da sessão não existe mais) ou TENANT_NOT_FOUND (a empresa informada não existe).",
    ),
  codedError: z.object({ code: z.string(), message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { occurrenceTypeSchemas, occurrenceTypeResponses };
