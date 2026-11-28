import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteShipperSchema = z.object({
  shipperId: z
    .string(fieldError({ required: "ID do embarcador é obrigatório!" }))
    .uuid("ID do embarcador é inválido."),
});

export { updateDeleteShipperSchema };
