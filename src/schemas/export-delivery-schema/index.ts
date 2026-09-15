import { z } from "zod";

/**
 * The delivery exports, which need one thing the shared export schema has not:
 * the company, because MASTER exports on behalf of one.
 */
const exportDeliverySchema = z.object({
  search: z.string().optional(),
  format: z.enum(["csv", "excel"]).optional().default("csv"),

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
    .describe("Exporta apenas um status."),
});

export { exportDeliverySchema };
