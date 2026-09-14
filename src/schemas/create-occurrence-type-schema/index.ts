import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

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
});

export {
  createOccurrenceTypeSchema,
  occurrenceTypeNameSchema,
  occurrenceTypeDescriptionSchema,
};
