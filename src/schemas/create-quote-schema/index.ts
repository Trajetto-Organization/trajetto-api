import { z } from "zod";
import {
  hasInlineConsecutiveSpaces,
  hasSpaceAtLineEdges,
} from "@/shared/delivery/text-rules";
import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

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
  // A form post sends every line break as CRLF. Read as one "\n" (what the
  // web action sends). The multiline rule (decision 5.5): a line break is not
  // a space, so blank lines between paragraphs pass, while doubled spaces and
  // a space at either end of a line stay refused, as on the web.
  message: z.preprocess(
    (value) =>
      emptyStringToNull(
        typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value,
      ),
    z
      .string()
      .max(230, "A mensagem deve ter no máximo 230 caracteres")
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A mensagem não pode ser vazia ou conter apenas espaços.",
          });

          return;
        }

        if (hasInlineConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A mensagem não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A mensagem não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        if (hasSpaceAtLineEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "As linhas da mensagem não podem começar ou terminar com espaço.",
          });
        }
      })
      .nullable()
      .optional(),
  ),

  // The Cloudflare Turnstile token the web's widget produced, forwarded for
  // the API to verify (src/shared/security/turnstile.ts). Optional in the
  // schema because Turnstile is off without TURNSTILE_SECRET_KEY (dev, tests);
  // with the secret set, the check refuses a request without it. Not stored.
  turnstileToken: z.string().max(2048).optional(),
});

export { createQuoteSchema };
