import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateMasterUserParamsSchema = z.object({
  masterUserId: z
    .string({ required_error: "ID do usuário master é obrigatório!" })
    .uuid("ID do usuário master é inválido."),
});

const updateMasterUserSchema = z
  .object({
    // A master has no company, and no edit gives them one.
    ...tenantLockedShape,
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
    // Decision 4.9: nobody types another master's password, and no
    // password is mailed. A single-use link is sent instead.
    sendPasswordSetupLink: z
      .boolean({ invalid_type_error: "Envio do link de senha inválido." })
      .optional()
      .describe(
        "Envia ao master um link de uso único (24 h) para definir uma nova senha.",
      ),
  })
  .refine((data) => data.name || data.email || data.sendPasswordSetupLink, {
    message:
      "Informe ao menos uma alteração: nome, e-mail ou o envio do link de redefinição de senha.",
  });

export { updateMasterUserSchema, updateMasterUserParamsSchema };
