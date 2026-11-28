import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";
import { occurrenceFormFieldsSchema } from "@/modules/occurrence-type/form/occurrence-form-rules";
import {
  OCCURRENCE_CATEGORIES,
  PAUSE_KINDS,
} from "@/modules/occurrence-type/rules/occurrence-category-rules";
import { fieldError } from "@/shared/validation/field-error";

const occurrenceTypeNameSchema = z
  .string()
  .min(2, "O nome do tipo de ocorrência deve ter no mínimo 2 caracteres.")
  .max(100, "O nome do tipo de ocorrência deve ter no máximo 100 caracteres.")
  .superRefine((value, ctx) => {
    if (isEmptyOrWhitespace(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do tipo de ocorrência não pode conter apenas espaços.",
      });

      return;
    }

    if (hasConsecutiveSpaces(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "O nome do tipo de ocorrência não deve conter espaços consecutivos.",
      });

      return;
    }

    if (hasSpaceAtEdges(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "O nome do tipo de ocorrência não pode começar ou terminar com espaço em branco.",
      });
    }
  });

const occurrenceTypeDescriptionSchema = z.preprocess(
  (val) => (val === "" ? null : val),
  z
    .string()
    .max(300, "A descrição deve ter no máximo 300 caracteres.")
    .superRefine((value, ctx) => {
      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A descrição não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A descrição não pode começar ou terminar com espaço em branco.",
        });
      }
    })
    .nullable()
    .optional(),
);

/** How long the company's own code for a type can be (L8). */
const OCCURRENCE_TYPE_CODE_MAX_LENGTH = 40;

/**
 * The company's own code for the type, the "código do ERP" (plan of
 * 02/11/2026, L8). An ERP matches an occurrence by it, because the name is
 * the company's to rename. Optional, unique per company (409
 * OCCURRENCE_TYPE_CODE_TAKEN from the index), compared exactly as typed —
 * ERPs that tell "a1" from "A1" exist. "" reads as none, like the description.
 */
const occurrenceTypeCodeSchema = z.preprocess(
  (val) => (val === "" ? null : val),
  z
    .string(fieldError({ invalid: "O código do tipo deve ser um texto." }))
    .max(
      OCCURRENCE_TYPE_CODE_MAX_LENGTH,
      `O código do tipo deve ter no máximo ${OCCURRENCE_TYPE_CODE_MAX_LENGTH} caracteres.`,
    )
    .refine(
      (value) => !hasSpaceAtEdges(value),
      "O código do tipo não pode começar ou terminar com espaço.",
    )
    // A line break or a tab in a code is a key nobody can type back into the
    // ERP to match it.
    .refine(
      // eslint-disable-next-line no-control-regex
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "O código do tipo não pode ter quebras de linha nem caracteres de controle.",
    )
    .nullable()
    .optional()
    .describe(
      `O código deste tipo no seu ERP (opcional, até ${OCCURRENCE_TYPE_CODE_MAX_LENGTH} caracteres, único na empresa e com diferença entre maiúsculas e minúsculas). Sai como \`occurrence_code\` no webhook \`occurrence.reported\` e em /integration/v1/events, para o ERP casar a ocorrência sem depender do nome. Vazio ou nulo = sem código.`,
    ),
);

/**
 * The type's form (decision 6.2). Null or [] = no form. Validated whole —
 * keys, labels, options, limits — so the app never renders a form it cannot
 * check.
 */
const occurrenceTypeFormFieldsSchema = occurrenceFormFieldsSchema
  .nullable()
  .optional()
  .describe(
    "Formulário que o motorista preenche ao relatar este tipo: até 20 campos `{ key, label, type: text|number|boolean|select|date, required, help?, options? (select), max_length?/multiline? (text), min?/max?/integer? (number) }`. `key` é a chave estável das respostas (minúsculas, números e _). Nulo ou vazio = sem formulário.",
  );

const occurrenceCategorySchema = z
  .enum(OCCURRENCE_CATEGORIES, {
    error: "Categoria inválida. Use DELIVERED, NOT_DELIVERED ou PAUSE.",
  })
  .describe(
    "Categoria (decisão 14.3): DELIVERED (entrega: registrar comprova a entrega), NOT_DELIVERED (não entrega: os tipos de problema) ou PAUSE (pausa da jornada, decisão 14.4). Não muda depois que o tipo foi usado, nem nos tipos padrão.",
  );

const pauseKindSchema = z
  .enum(PAUSE_KINDS, {
    error: "Natureza legal inválida. Use MEAL, REST ou OTHER.",
  })
  .nullable()
  .describe(
    "Só em PAUSE, e obrigatória lá: a natureza legal que o relatório da Lei 13.103 lê (MEAL = refeição, REST = descanso, OTHER = outra).",
  );

const createOccurrenceTypeSchema = z.object({
  name: occurrenceTypeNameSchema,
  description: occurrenceTypeDescriptionSchema,
  requires_photo: z
    .boolean()
    .default(false)
    .describe("Exigir foto ao registrar uma ocorrência deste tipo."),
  blocks_delivery: z
    .boolean()
    .default(false)
    .describe(
      "Ocorrência impeditiva: ao ser registrada, a entrega ativa vira Insucesso (FAILED).",
    ),
  requires_authorization: z
    .boolean()
    .default(false)
    .describe(
      "Exige autorização da torre: o relato do motorista fica PENDENTE, sem efeito, até alguém aprovar ou negar (decisão 6.3).",
    ),
  form_fields: occurrenceTypeFormFieldsSchema,
  category: occurrenceCategorySchema.default("NOT_DELIVERED"),
  requires_receipt_photo: z
    .boolean()
    .default(false)
    .describe(
      "Exigir a foto do canhoto (só pela câmera; lida pela IA quando a empresa tem o módulo). Não vale em PAUSE.",
    ),
  requires_signature: z
    .boolean()
    .default(false)
    .describe(
      "Exigir a assinatura na tela. Em DELIVERED o quadro de assinatura é sempre oferecido; isto só o torna obrigatório. Não vale em PAUSE.",
    ),
  pause_kind: pauseKindSchema.optional(),
  code: occurrenceTypeCodeSchema,
});

export {
  OCCURRENCE_TYPE_CODE_MAX_LENGTH,
  occurrenceTypeCodeSchema,
  occurrenceCategorySchema,
  pauseKindSchema,
  createOccurrenceTypeSchema,
  occurrenceTypeNameSchema,
  occurrenceTypeDescriptionSchema,
  occurrenceTypeFormFieldsSchema,
};
