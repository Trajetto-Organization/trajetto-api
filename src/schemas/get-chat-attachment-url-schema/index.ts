import { z } from "zod";

const getChatAttachmentUrlSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  messageId: z.string().uuid("ID da mensagem é inválido."),
});

export { getChatAttachmentUrlSchema };
