import { z } from "zod";

import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

/**
 * Who the chat can talk to: the company's active drivers.
 *
 * Its own endpoint, under `delivery_manage:read`, instead of the driver
 * search. That one needs `driver_manage:read`, so a tower user allowed to
 * send found an empty list in "Nova conversa" and in the mass notice.
 */
const listChatRecipientsSchema = cursorPaginationSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),

  app: z
    .enum(["WITH_APP", "WITHOUT_APP"], {
      errorMap: () => ({ message: "Filtro de aplicativo inválido." }),
    })
    .optional()
    .describe(
      "WITH_APP: só quem tem conta ativa no aplicativo (recebe o aviso). WITHOUT_APP: só quem não tem. Ausente: todos os ativos.",
    ),
});

export { listChatRecipientsSchema };
