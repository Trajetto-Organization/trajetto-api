import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  plannedInstantField,
  refineWindowOrder,
  routeDayField,
  routeDestinationField,
} from "@/schemas/route-schema";

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
 *
 * The plan of the route it creates (decision 6.5) rides along with the same
 * fields and rules as the Rotas screen: the day (today in the company's zone
 * when absent), the destination and the planned departure and return. Without
 * them the route was always "today in UTC" with no planned departure, and the
 * tower's punctuality said "Sem horário" for every one of them.
 */
const assignDeliveriesSchema = z
  .object({
    ...tenantLockedShape,
    deliveryIds: z
      .array(
        z.string().uuid("Cada entrega deve ter um identificador válido."),
        {
          required_error: "Selecione ao menos uma entrega para atribuir.",
        },
      )
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
      .describe(
        "Veículo em operação da mesma empresa. A rota é liberada com ele.",
      ),
    scheduled_date: routeDayField("A data da rota é inválida.")
      .optional()
      .describe(
        "O dia da rota, AAAA-MM-DD. Ausente, o dia de hoje no fuso da empresa.",
      ),
    destination: routeDestinationField.describe(
      "Para onde a rota vai, em texto livre (até 160 caracteres).",
    ),
    planned_departure_at: plannedInstantField("A saída prevista").describe(
      "ISO 8601 com fuso. Deve cair no dia da rota, no fuso da empresa.",
    ),
    planned_arrival_at: plannedInstantField("O retorno previsto").describe(
      "ISO 8601 com fuso. Igual ou posterior à saída prevista.",
    ),
  })
  .superRefine(refineWindowOrder);

export { assignDeliveriesSchema };
