import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  InvalidMessageTemplateError,
  TEMPLATE_VARIABLES,
  inspectTemplate,
} from "@/shared/delivery/message-template";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const AVAILABLE = TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(", ");

/**
 * The published variables, checked where the form's other errors come from
 * (a 400 VALIDATION_ERROR naming the field), with the list the author can
 * pick from. `{{ gabriel }}` is the variable `gabriel`: Handlebars ignores
 * the spaces inside the braces, so the check reads the parsed template, not
 * the text. The use case repeats the check (syntax, blocks, helpers) as the
 * authority for any other caller.
 */
function checkVariables(value: string, ctx: z.RefinementCtx): void {
  let unknown: string[];

  try {
    unknown = inspectTemplate(value).unknown;
  } catch (error) {
    if (!(error instanceof InvalidMessageTemplateError)) throw error;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "A mensagem tem um erro de formatação. Confira se cada variável abre com {{ e fecha com }}, como {{destinatario}}.",
    });

    return;
  }

  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `A mensagem usa variáveis que não existem: ${unknown
        .map((name) => `{{${name}}}`)
        .join(", ")}. Use apenas: ${AVAILABLE}.`,
    });
  }
}

/**
 * A message a company writes to somebody who is not its customer's problem to
 * authenticate.
 *
 * The body caps at 900 characters because that is roughly where a WhatsApp
 * message stops being read, and a template longer than the screen it lands on
 * is a template nobody finishes.
 */
const saveDeliveryMessageTemplateSchema = z.object({
  ...tenantLockedShape,
  topic: z.enum(["DISPATCHED", "ON_THE_WAY", "DELIVERED", "FAILED"], {
    errorMap: () => ({
      message:
        "O momento deve ser DISPATCHED, ON_THE_WAY, DELIVERED ou FAILED.",
    }),
  }),

  channel: z.enum(["EMAIL", "WHATSAPP"], {
    errorMap: () => ({ message: "O canal deve ser EMAIL ou WHATSAPP." }),
  }),

  subject: z.preprocess(
    (value) => (value === "" ? null : value),
    z
      .string()
      .max(150, "O assunto deve ter no máximo 150 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "O assunto não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O assunto não pode começar ou terminar com espaço em branco.",
          });

          return;
        }

        checkVariables(value, ctx);
      })
      .nullable()
      .optional()
      .describe("Ignorado no WhatsApp, que não carrega assunto."),
  ),

  body: z
    .string({ required_error: "O texto da mensagem é obrigatório." })
    .max(900, "O texto da mensagem deve ter no máximo 900 caracteres.")
    .superRefine((value, ctx) => {
      // Ten spaces used to pass the length check and render an empty e-mail
      // (the render trims).
      if (value.trim().length < 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O texto da mensagem deve ter no mínimo 10 caracteres.",
        });

        return;
      }

      checkVariables(value, ctx);
    })
    .describe(`Variáveis disponíveis: ${AVAILABLE}`),

  is_active: z.boolean().optional().default(true),
});

const listDeliveryMessageTemplateSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

export { listDeliveryMessageTemplateSchema, saveDeliveryMessageTemplateSchema };
