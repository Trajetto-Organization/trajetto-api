import { z } from "zod";

import { OCCURRENCE_FORM_FIELD_TYPES } from "./occurrence-form-rules";

/**
 * A stored form as the responses carry it (normalized: `required` always
 * present; `max_length`/`multiline` on text, `integer` on number, `options`
 * on select). One description for the catalogue, the driver's day and the
 * delivery detail.
 */
const occurrenceFormFieldDoc = z.object({
  key: z
    .string()
    .describe("Chave estável da resposta (minúsculas, números e _)."),
  label: z.string().describe("A pergunta, como o motorista lê."),
  type: z.enum(OCCURRENCE_FORM_FIELD_TYPES),
  required: z.boolean(),
  help: z.string().optional().describe("Orientação ao motorista, sob o campo."),
  options: z.array(z.string()).optional().describe("Só `select`: as opções."),
  max_length: z
    .number()
    .optional()
    .describe("Só `text`: limite de caracteres."),
  multiline: z
    .boolean()
    .optional()
    .describe("Só `text`: aceita quebras de linha."),
  min: z.number().optional().describe("Só `number`."),
  max: z.number().optional().describe("Só `number`."),
  integer: z
    .boolean()
    .optional()
    .describe("Só `number`: aceita apenas inteiros."),
});

const occurrenceFormFieldsDoc = z
  .array(occurrenceFormFieldDoc)
  .nullable()
  .describe("O formulário do tipo (decisão 6.2); nulo quando não há.");

/** Answers by field key: text/select/date as strings, numbers, sim/não. */
const occurrenceFormAnswersDoc = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .nullable()
  .describe(
    "Respostas do formulário do tipo de ocorrência, por chave do campo.",
  );

export {
  occurrenceFormAnswersDoc,
  occurrenceFormFieldDoc,
  occurrenceFormFieldsDoc,
};
