import { z } from "zod";

import { EnumPermissionKey } from "@/config/permissions";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const permissionKeyEnum = z.nativeEnum(EnumPermissionKey, {
  errorMap: (issue, ctx) => {
    const validValues = Object.values(EnumPermissionKey).join(", ");
    return {
      message: `A permissão informada não é válida. Valores válidos: ${validValues}`,
    };
  },
});

const updatePermissionSchema = z
  .object({
    action: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .min(3, "O nome da permissão deve ter no mínimo 3 caracteres.")
        .superRefine((value, ctx) => {
          if (value.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome da permissão não pode ser vazio ou conter apenas espaços.",
            });

            return;
          }

          if (value.length > 100) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "O nome da permissão não deve exceder 100 caracteres.",
            });

            return;
          }

          if (hasConsecutiveSpaces(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome da permissão não deve conter espaços consecutivos.",
            });

            return;
          }

          if (hasSpaceAtEdges(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome da permissão não pode começar ou terminar com espaço em branco.",
            });

            return;
          }

          const regex =
            /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
          if (!regex.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome da permissão deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
            });
          }
        })
        .optional()
        .nullable(),
    ),
    canRead: z.boolean().optional().nullable(),
    canWrite: z.boolean().default(false).optional().nullable(),
    businessId: z
      .string({ required_error: "ID da empresa é obrigatório!" })
      .uuid("ID da empresa é inválido."),
    profileAccessId: z
      .string({ required_error: "ID do perfil de acesso é obrigatório!" })
      .uuid("ID do perfil de acesso é inválido."),
    permissionKey: permissionKeyEnum.optional(),
  })
  .refine((data) => data.canRead, {
    message: "Selecione a opção Leitura (caso deseje, marque também Escrita).",
    path: ["canRead"],
  });

export { updatePermissionSchema };
