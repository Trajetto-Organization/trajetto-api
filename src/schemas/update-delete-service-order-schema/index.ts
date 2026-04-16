import { z } from "zod";

const updateDeleteServiceOrderSchema = z.object({
  serviceOrderId: z
    .string({ required_error: "ID da ordem de serviço é obrigatório!" })
    .uuid("ID da ordem de serviço é inválido."),
});

export { updateDeleteServiceOrderSchema };
