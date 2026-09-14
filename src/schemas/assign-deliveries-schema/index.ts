import { z } from "zod";

/**
 * Batch assignment: the whole selection succeeds or nothing is written.
 * Each call fully defines the assignment — an omitted vehicleId clears the
 * previous vehicle on reassignment instead of keeping a stale one.
 */
const assignDeliveriesSchema = z.object({
  deliveryIds: z
    .array(z.string().uuid("Cada entrega deve ter um identificador válido."), {
      required_error: "Selecione ao menos uma entrega para atribuir.",
    })
    .min(1, "Selecione ao menos uma entrega para atribuir.")
    .max(100, "Atribua no máximo 100 entregas por vez.")
    .describe("Entregas pendentes selecionadas na tabela."),
  driverId: z
    .string({ required_error: "O motorista é obrigatório." })
    .uuid("O motorista deve ter um identificador válido.")
    .describe("Motorista ativo da mesma empresa."),
  vehicleId: z
    .string()
    .uuid("O veículo deve ter um identificador válido.")
    .nullable()
    .optional()
    .describe("Opcional; ausente limpa o veículo da atribuição anterior."),
});

export { assignDeliveriesSchema };
