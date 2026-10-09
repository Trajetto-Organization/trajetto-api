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
      .optional()
      .describe("O `created_at` de `nextCursor`: busca as mais antigas. Vai junto com beforeId."),
    beforeId: z
      .string()
      .uuid("Cursor beforeId é inválido.")
      .optional()
      .describe("O `id` de `nextCursor`. Vai junto com beforeAt."),

    // The mirror, walking towards the present.
    afterAt: z
      .string()
      .datetime("Cursor afterAt deve ser uma data ISO.")
      .optional()
      .describe("O `created_at` de `previousCursor`: busca as mais novas. Vai junto com afterId."),
    afterId: z
      .string()
      .uuid("Cursor afterId é inválido.")
      .optional()
      .describe("O `id` de `previousCursor`. Vai junto com afterAt."),

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
      .refine((value) => value <= 100, "No máximo 100 mensagens por página.")
      .describe("Mensagens por página, até 100; padrão 30."),

    search: z.string().optional().describe("Filtra o histórico por texto."),

    // Decision 6.7: one thread per driver, its history narrowed by the
    // delivery or the route a message was about. Ids of another company
    // simply match nothing inside this thread.
    deliveryId: z
      .string()
      .uuid("ID da entrega é inválido.")
      .optional()
      .describe("Só as mensagens sobre esta entrega."),

    routeId: z
      .string()
      .uuid("ID da rota é inválido.")
      .optional()
      .describe("Só as mensagens desta rota."),

    // Decision 14.5: the conversation of one support ticket. A ticket of
    // another company (or, for a driver, of another driver) answers 404
    // SUPPORT_TICKET_NOT_FOUND.
    ticketId: z
      .string()
      .uuid("ID do atendimento é inválido.")
      .optional()
      .describe("Só as mensagens deste atendimento (ticket)."),
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
