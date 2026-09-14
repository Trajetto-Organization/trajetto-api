import { z } from "zod";

const markChatReadSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  threadId: z.string().uuid("ID da conversa é inválido."),

  readAt: z
    .string()
    .datetime("readAt deve ser uma data ISO.")
    .optional()
    .describe(
      "created_at da mensagem mais recente que o leitor realmente tem na tela. Ausente, o servidor usa agora. O servidor limita ao instante atual e o cursor nunca retrocede.",
    ),
});

export { markChatReadSchema };
