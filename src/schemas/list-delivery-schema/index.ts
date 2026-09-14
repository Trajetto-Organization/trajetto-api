import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

const listDeliverySchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  status: z
    .enum(["PENDING", "IN_TRANSIT", "DELIVERED", "FAILED", "CANCELLED"])
    .optional()
    .describe("Filtra por status da entrega."),
  shipperId: z.string().uuid("ID do embarcador é inválido.").optional(),
  driverId: z.string().uuid("ID do motorista é inválido.").optional(),
});

export { listDeliverySchema };
