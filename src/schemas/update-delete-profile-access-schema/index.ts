import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteProfileAccessSchema = z.object({
  profileAccessId: z
    .string(fieldError({ required: "ID do perfil de acesso é obrigatório!" }))
    .uuid("ID do perfil de acesso é inválido."),
});

export { updateDeleteProfileAccessSchema };
