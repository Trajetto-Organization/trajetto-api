import { z } from "zod";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateMasterUserParamsSchema = z.object({
  masterUserId: z.string().min(1, "O ID do usuário master é obrigatório."),
});

const updateMasterUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "O e-mail é obrigatório.")
      .email("O e-mail informado não é válido.")
      .max(100, "O e-mail deve ter no máximo 100 caracteres.")
      .optional()
      .nullable(),
    name: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .superRefine((value, ctx) => {
          if (value.length > 100) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "O nome de usuário não deve exceder 100 caracteres.",
            });

            return;
          }

          if (hasConsecutiveSpaces(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome de usuário não deve conter espaços consecutivos.",
            });

            return;
          }

          if (hasSpaceAtEdges(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome de usuário não pode começar ou terminar com espaço em branco.",
            });

            return;
          }

          if (!/^\S+ \S+(?: \S+)*$/.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Por favor, insira o nome de usuário completo.",
            });

            return;
          }

          const regex =
            /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
          if (!regex.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome de usuário deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
            });
          }
        })
        .optional()
        .nullable(),
    ),
    password: z.preprocess(
      emptyStringToNull,
      z
        .string()
        .min(7, "A senha deve ter pelo menos 7 caracteres.")
        .max(100, "A senha deve ter no máximo 100 caracteres.")
        .refine((value) => !/\s/.test(value), {
          message: "A senha não deve conter espaços.",
        })
        .optional()
        .nullable(),
    ),
  })
  .refine((data) => data.name || data.email || data.password, {
    message:
      "Pelo menos um campo deve ser informado para atualização (nome, e-mail ou senha).",
  });

export { updateMasterUserSchema, updateMasterUserParamsSchema };
