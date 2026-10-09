import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import { CnhCategory } from "@prisma/client";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateVehicleTypeSchema = z.object({
  ...tenantLockedShape,
  description: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .min(3, "A descrição deve ter no mínimo 3 caracteres.")
      .max(100, "A descrição deve ter no máximo 100 caracteres.")
      .superRefine((value, ctx) => {
        if (value.length > 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O nome não deve exceder 100 caracteres.",
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O nome não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        const regex = /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
        if (!regex.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
          });
        }
      })
      .optional()
      .nullable(),
  ),
  number_of_axles: z
    .number()
    .int("O número de eixos deve ser um número inteiro.")
    .min(1, "O número de eixos deve ser no mínimo 1.")
    .max(10, "O número de eixos deve ser no máximo 10.")
    .optional(),
  // The licence a driver needs for this kind of vehicle (decision 8.5);
  // null or absent = not configured, and the assignment checks nothing.
  required_cnh_category: z.preprocess(
    (value) => (value === "" ? null : value),
    z
      .nativeEnum(CnhCategory, {
        errorMap: () => ({
          message: "Categoria de CNH inválida. Use A, B, C, D, E, AB, AC, AD ou AE.",
        }),
      })
      .nullable()
      .optional(),
  ),
});

export { updateVehicleTypeSchema };
