import { z } from "zod";

import { TEMPLATE_VARIABLES } from "@/shared/delivery/message-template";

/**
 * A message a company writes to somebody who is not its customer's problem to
 * authenticate.
 *
 * The body caps at 900 characters because that is roughly where a WhatsApp
 * message stops being read, and a template longer than the screen it lands on
 * is a template nobody finishes.
 */
const saveDeliveryMessageTemplateSchema = z.object({
  topic: z.enum(["DISPATCHED", "DELIVERED", "FAILED"], {
    errorMap: () => ({
      message: "O momento deve ser DISPATCHED, DELIVERED ou FAILED.",
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
      .nullable()
      .optional()
      .describe("Ignorado no WhatsApp, que não carrega assunto."),
  ),

  body: z
    .string({ required_error: "O texto da mensagem é obrigatório." })
    .min(10, "O texto da mensagem deve ter no mínimo 10 caracteres.")
    .max(900, "O texto da mensagem deve ter no máximo 900 caracteres.")
    .describe(
      `Variáveis disponíveis: ${TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(", ")}`,
    ),

  is_active: z.boolean().optional().default(true),
});

const listDeliveryMessageTemplateSchema = z.object({
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
});

export {
  listDeliveryMessageTemplateSchema,
  saveDeliveryMessageTemplateSchema,
};
