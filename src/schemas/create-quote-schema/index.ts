import { z } from "zod";

const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);
const isEmptyOrWhitespace = (value: string): boolean =>
  value.trim().length === 0;

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);

const createQuoteSchema = z.object({
  name: z.string().superRefine((value, ctx) => {
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
        message: "O nome não pode começar ou terminar com espaço em branco.",
      });
      return;
    }

    if (!/^\S+ \S+(?: \S+)*$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Por favor, insira o nome completo.",
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
  }),
  company: z
    .string()
    .min(1, "A empresa é obrigatória.")
    .max(150, "A empresa deve ter no máximo 150 caracteres.")
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da empresa não pode ser vazio ou conter apenas espaços.",
        });
        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome da empresa não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A empresa não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      if (!/^[\p{L}0-9]+(?:[ \-][\p{L}0-9]+)*$/u.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O empresa deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
        });
      }
    }),
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
  telephone: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        return val.replace(/\D/g, "");
      }

      return val;
    },
    z
      .string()
      .regex(
        /^\d{10,11}$/,
        "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      ),
  ),
  fleet_size: z.enum(["1-5", "6-15", "16-30", "31-50", "51-100", "101+"], {
    errorMap: () => ({
      message: "Por favor, selecione o tamanho da sua frota",
    }),
  }),
  message: z
    .string()
    .max(230, "A mensagem deve ter no máximo 230 caracteres")
    .optional(),
});

export { createQuoteSchema };
