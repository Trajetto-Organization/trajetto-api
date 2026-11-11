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
function checkVariables(
  value: string,
  ctx: z.RefinementCtx,
  /** Where the issue points when checked from the whole object. */
  path?: string[],
): void {
  let unknown: string[];

  try {
    unknown = inspectTemplate(value).unknown;
  } catch (error) {
    if (!(error instanceof InvalidMessageTemplateError)) throw error;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      ...(path ? { path } : {}),
      message:
        "A mensagem tem um erro de formatação. Confira se cada variável abre com {{ e fecha com }}, como {{destinatario}}.",
    });

    return;
  }

  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      ...(path ? { path } : {}),
      message: `A mensagem usa variáveis que não existem: ${unknown
        .map((name) => `{{${name}}}`)
        .join(", ")}. Use apenas: ${AVAILABLE}.`,
    });
  }
}

/**
 * The e-mail's text: at least ten characters that are not blanks (ten spaces
 * used to pass the length check and render an empty e-mail — the render
 * trims), and only the published variables.
 */
function checkEmailBody(value: string, ctx: z.RefinementCtx): void {
  if (value.trim().length < 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "O texto da mensagem deve ter no mínimo 10 caracteres.",
    });

    return;
  }

  checkVariables(value, ctx, ["body"]);
}

/**
 * A message a company writes to somebody who is not its customer's problem to
 * authenticate.
 *
 * Validated by channel (plan of 02/11/2026, B3). The e-mail is the company's
 * text: the body is required, capped at 900 characters, and checked. WhatsApp
 * is only the moment's switch — its text is the fixed template approved by
 * Meta — so only `topic` and `is_active` count there; a body or a subject
 * the previous web still sends is accepted and ignored, never refused, so
 * that web keeps saving during the rolling deploy.
 */
const saveDeliveryMessageTemplateSchema = z
  .object({
    ...tenantLockedShape,
    topic: z.enum(["DISPATCHED", "ON_THE_WAY", "DELIVERED", "FAILED"], {
      error: "O momento deve ser DISPATCHED, ON_THE_WAY, DELIVERED ou FAILED.",
    }),

    channel: z.enum(["EMAIL", "WHATSAPP"], {
      error: "O canal deve ser EMAIL ou WHATSAPP.",
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
      .string()
      .nullable()
      .optional()
      .describe(
        `Obrigatório no e-mail, com no máximo 900 caracteres. Variáveis disponíveis: ${AVAILABLE}. Ignorado no WhatsApp, que sai pelo modelo fixo aprovado pela Meta.`,
      ),

    is_active: z.boolean().optional().default(true),
  })
  .superRefine((data, ctx) => {
    // WhatsApp: the switch only. Nothing of the text is read or kept.
    if (data.channel !== "EMAIL") return;

    if (data.body === null || data.body === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "O texto da mensagem é obrigatório.",
      });

      return;
    }

    if (data.body.length > 900) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "O texto da mensagem deve ter no máximo 900 caracteres.",
      });

      return;
    }

    checkEmailBody(data.body, ctx);
  });

const listDeliveryMessageTemplateSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

export { listDeliveryMessageTemplateSchema, saveDeliveryMessageTemplateSchema };
