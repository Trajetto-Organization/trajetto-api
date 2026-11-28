import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteDriverSchema = z.object({
  driverId: z
    .string(fieldError({ required: "ID do motorista é obrigatório!" }))
    .uuid("ID do motorista é inválido."),
});

export { updateDeleteDriverSchema };
