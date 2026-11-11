import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

/** DELETE /user/me/sessions/:id (wave 2): one of the person's own sessions. */
const ownSessionParamsSchema = z.object({
  id: z
    .string(fieldError({ required: "ID da sessão é obrigatório." }))
    .uuid("ID da sessão é inválido.")
    .describe("O `id` da sessão, como GET /user/me/sessions o devolve."),
});

export { ownSessionParamsSchema };
