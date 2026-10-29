import { z } from "zod";

const updateDeleteDeliverySchema = z.object({
  deliveryId: z
    .string({ required_error: "ID da entrega é obrigatório!" })
    .uuid("ID da entrega é inválido."),
});

export { updateDeleteDeliverySchema };
