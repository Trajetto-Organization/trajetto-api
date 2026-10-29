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
    errorMap: () => ({
      message: "Categoria inválida. Use DELIVERED, NOT_DELIVERED ou PAUSE.",
    }),
  })
  .describe(
    "Categoria (decisão 14.3): DELIVERED (entrega: registrar comprova a entrega), NOT_DELIVERED (não entrega: os tipos de problema) ou PAUSE (pausa da jornada, decisão 14.4). Não muda depois que o tipo foi usado, nem nos tipos padrão.",
  );

const pauseKindSchema = z
  .enum(PAUSE_KINDS, {
    errorMap: () => ({
      message: "Natureza legal inválida. Use MEAL, REST ou OTHER.",
    }),
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
});

export {
  occurrenceCategorySchema,
  pauseKindSchema,
  createOccurrenceTypeSchema,
  occurrenceTypeNameSchema,
  occurrenceTypeDescriptionSchema,
  occurrenceTypeFormFieldsSchema,
};
