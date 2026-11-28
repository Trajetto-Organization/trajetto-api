import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const revokeUserAccessSchema = z.object({
  userId: z
    .string(fieldError({ required: "ID do usuário é obrigatório!" }))
    .uuid("ID do usuário é inválido."),
});

export { revokeUserAccessSchema };
