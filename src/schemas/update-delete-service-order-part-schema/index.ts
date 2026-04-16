import { z } from "zod";

const updateDeleteServiceOrderPartSchema = z.object({
  serviceOrderPartId: z
    .string({ required_error: "ID da peça de ordem de serviço é obrigatório!" })
    .uuid("ID da peça de ordem de serviço é inválido."),
});

export { updateDeleteServiceOrderPartSchema };
