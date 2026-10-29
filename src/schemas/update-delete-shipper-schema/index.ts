import { z } from "zod";

const updateDeleteShipperSchema = z.object({
  shipperId: z
    .string({ required_error: "ID do embarcador é obrigatório!" })
    .uuid("ID do embarcador é inválido."),
});

export { updateDeleteShipperSchema };
