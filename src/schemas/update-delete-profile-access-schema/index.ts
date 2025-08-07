import { z } from "zod";

const updateDeleteProfileAccessSchema = z.object({
  profileAccessId: z.string().min(1, "O ID do perfil de acesso é obrigatório!"),
});

export { updateDeleteProfileAccessSchema };
