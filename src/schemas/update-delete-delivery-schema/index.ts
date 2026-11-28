import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteDeliverySchema = z.object({
  deliveryId: z
    .string(fieldError({ required: "ID da entrega é obrigatório!" }))
    .uuid("ID da entrega é inválido."),
});

export { updateDeleteDeliverySchema };
