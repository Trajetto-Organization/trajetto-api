import { z } from "zod";

/** DELETE /user/me/sessions/:id (wave 2): one of the person's own sessions. */
const ownSessionParamsSchema = z.object({
  id: z
    .string({ required_error: "ID da sessão é obrigatório." })
    .uuid("ID da sessão é inválido.")
    .describe("O `id` da sessão, como GET /user/me/sessions o devolve."),
});

export { ownSessionParamsSchema };
