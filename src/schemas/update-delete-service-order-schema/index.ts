import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteServiceOrderSchema = z.object({
  serviceOrderId: z
    .string(fieldError({ required: "ID da ordem de serviço é obrigatório!" }))
    .uuid("ID da ordem de serviço é inválido."),
});

export { updateDeleteServiceOrderSchema };
