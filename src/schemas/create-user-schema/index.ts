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

const createUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "O e-mail é obrigatório.")
      .email("O e-mail informado não é válido.")
      .max(100, "O e-mail deve ter no máximo 100 caracteres."),
    name: z.string().superRefine((value, ctx) => {
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
    }),
    password: z
      .string()
      .min(7, "A senha deve ter pelo menos 7 caracteres.")
      .max(100, "A senha deve ter no máximo 100 caracteres.")
      .refine((value) => !/\s/.test(value), {
        message: "A senha não deve conter espaços.",
      })
      .optional(),
    role: roleEnum,
    businessId: z.string().min(1, "A empresa é obrigatória!"),
    profileAccessId: z.string().optional(),
    driverId: z
      .string()
      .optional()
      .refine(
        (val) => !val || val === "" || z.string().uuid().safeParse(val).success,
        {
          message: "O ID do motorista deve ser um UUID válido.",
        },
      ),
    userType: z.enum(["employee", "driver"]).optional(),
  })
  .superRefine((data, ctx) => {
    // BUSINESS_ADMIN does not need profileAccessId or driverId
    if (data.role === "BUSINESS_ADMIN") {
      if (data.profileAccessId || data.driverId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Administrador de empresa não deve ter perfil de acesso ou motorista vinculado.",
          path: ["role"],
        });
      }
      return;
    }

    // BUSINESS_USER needs either profileAccessId OR driverId (but not both)
    if (data.role === "BUSINESS_USER") {
      const hasProfile =
        data.profileAccessId && data.profileAccessId.trim() !== "";
      const hasDriver = data.driverId && data.driverId.trim() !== "";

      // If you don't have either of these
      if (!hasProfile && !hasDriver) {
        // Check userType to determine which error to show
        if (data.userType === "driver") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Selecione um motorista!",
            path: ["driverId"],
          });
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Selecione um perfil de acesso!",
            path: ["profileAccessId"],
          });
        }
        return;
      }

      // If you have both
      if (hasProfile && hasDriver) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Usuário não pode ter tanto um perfil de acesso quanto um motorista vinculado. Escolha apenas um.",
          path: ["driverId"],
        });
        return;
      }
    }
  });

export { createUserSchema };
