import { z } from "zod";

const listChatMessagesSchema = z
  .object({
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe(
        "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
      ),
    threadId: z
      .string()
      .uuid("ID da conversa é inválido.")
      .optional()
      .describe(
        "Tem precedência. O motorista pode omitir: a própria conversa é resolvida pelo token.",
      ),

    driverId: z
      .string()
      .uuid("ID do motorista é inválido.")
      .optional()
      .describe(
        "Alternativa ao threadId para a equipe: resolve a conversa com esse motorista no servidor. Sem conversa ainda, responde threadId nulo e lista vazia — nunca erro.",
      ),

    // The pair is the exclusive cursor: only messages strictly older come
    // back. Two fields because created_at alone is not unique.
    beforeAt: z
      .string()
      .datetime("Cursor beforeAt deve ser uma data ISO.")
      .optional(),
    beforeId: z.string().uuid("Cursor beforeId é inválido.").optional(),

    // The mirror, walking towards the present.
    afterAt: z
      .string()
      .datetime("Cursor afterAt deve ser uma data ISO.")
      .optional(),
    afterId: z.string().uuid("Cursor afterId é inválido.").optional(),

    aroundMessageId: z
      .string()
      .uuid("ID da mensagem é inválido.")
      .optional()
      .describe(
        "Centraliza a página nessa mensagem em vez de no fim da conversa — o que 'pular para a mensagem' de um resultado de busca precisa. Tem precedência sobre os cursores.",
      ),

    // Querystrings are strings; the transform hands the use case a number.
    limit: z
      .string()
      .optional()
      .transform((value) => {
        const parsed = Number(value);

        return Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
      })
      .refine((value) => value <= 100, "No máximo 100 mensagens por página."),

    search: z.string().optional().describe("Filtra o histórico por texto."),
  })
  .refine(
    (query) => Boolean(query.beforeAt) === Boolean(query.beforeId),
    "beforeAt e beforeId formam o cursor e viajam juntos.",
  )
  .refine(
    (query) => Boolean(query.afterAt) === Boolean(query.afterId),
    "afterAt e afterId formam o cursor e viajam juntos.",
  );

export { listChatMessagesSchema };
