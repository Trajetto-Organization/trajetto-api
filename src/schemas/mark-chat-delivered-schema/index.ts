import { z } from "zod";

const markChatDeliveredSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  threadId: z.string().uuid("ID da conversa é inválido."),

  // The created_at of the newest message already on the device. Optional:
  // without it the server takes the moment the receipt arrived.
  deliveredAt: z
    .string()
    .datetime("deliveredAt deve ser uma data ISO.")
    .optional()
    .describe(
      "created_at da mensagem mais recente que o aparelho já tem. O servidor limita ao instante atual.",
    ),
});

export { markChatDeliveredSchema };
