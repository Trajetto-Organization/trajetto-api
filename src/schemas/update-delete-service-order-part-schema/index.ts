import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteServiceOrderPartSchema = z.object({
  serviceOrderPartId: z
    .string(
      fieldError({ required: "ID da peça de ordem de serviço é obrigatório!" }),
    )
    .uuid("ID da peça de ordem de serviço é inválido."),
});

export { updateDeleteServiceOrderPartSchema };
