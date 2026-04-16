import { z } from "zod";

const updateDeleteProfileAccessSchema = z.object({
  profileAccessId: z
    .string({ required_error: "ID do perfil de acesso é obrigatório!" })
    .uuid("ID do perfil de acesso é inválido."),
});

export { updateDeleteProfileAccessSchema };
