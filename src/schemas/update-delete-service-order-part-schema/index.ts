import { z } from "zod";

const updateDeleteServiceOrderPartSchema = z.object({
  serviceOrderPartId: z
    .string()
    .uuid("O ID da peça de ordem de serviço é obrigatório!"),
});

export { updateDeleteServiceOrderPartSchema };
