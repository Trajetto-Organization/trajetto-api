import { z } from "zod";

/**
 * Batch assignment, which creates and releases a route for the selection.
 *
 * The whole selection succeeds or nothing is written, and each call fully
 * defines the assignment: reassigning moves the documents to a new route and
 * gives up the stop they held, which is only legal while the previous route
 * has not left.
 *
 * The vehicle is REQUIRED, and used not to be. A released route needs one —
 * discovering at the truck that none was assigned costs a phone call and a
 * morning — and the old shortcut could hand a driver twelve documents and no
 * plate without saying so anywhere.
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
    .string({ required_error: "O veículo é obrigatório." })
    .uuid("O veículo deve ter um identificador válido.")
    .describe("Veículo em operação da mesma empresa. A rota é liberada com ele."),
});

export { assignDeliveriesSchema };
