import { z } from "zod";

const updateDeleteDriverSchema = z.object({
  driverId: z
    .string({ required_error: "ID do motorista é obrigatório!" })
    .uuid("ID do motorista é inválido."),
});

export { updateDeleteDriverSchema };
