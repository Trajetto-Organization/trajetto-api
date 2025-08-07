import { z } from "zod";
import { UserBusinessRole } from "@/modules/user/dtos/user-dto";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

const roleEnum = z.nativeEnum(UserBusinessRole, {
  errorMap: (issue, ctx) => {
    const validValues = Object.values(UserBusinessRole).join(", ");
    return {
      message: `Nível de acesso do usuário inválido. Valores válidos: ${validValues}`,
    };
  },
});

const updateUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "O e-mail é obrigatório.")
      .email("O e-mail informado não é válido.")
      .max(100, "O e-mail deve ter no máximo 100 caracteres.")
      .optional()
      .or(z.literal("")),
    name: z
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
            message: "O nome de usuário não deve conter espaços consecutivos.",
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

        const regex = /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
        if (!regex.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de usuário deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
          });
        }
      })
      .optional()
      .or(z.literal("")),
    password: z
      .string()
      .min(7, "A senha deve ter pelo menos 7 caracteres.")
      .max(100, "A senha deve ter no máximo 100 caracteres.")
      .optional()
      .or(z.literal("")),
    role: roleEnum.optional().nullable(),
    businessId: z.string().min(1, "A empresa é obrigatória!"),
    profileAccessId: z.string().or(z.literal("")),
  })
  .refine(
    (data) => {
      if (data.role && data.role !== "BUSINESS_ADMIN") {
        return data.profileAccessId.trim() !== "";
      }

      return true;
    },
    {
      message: "O Perfil de acesso é obrigatório!",
      path: ["profileAccessId"],
    },
  );

export { updateUserSchema };
