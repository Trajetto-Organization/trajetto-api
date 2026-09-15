import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";

/**
 * Every schema of the route module, in one place.
 *
 * Grouped rather than split into a folder per body, because these describe one
 * entity and its stops and they change together — a status added to the state
 * machine touches the filter and the response in the same edit.
 */
const routeStatusEnum = z.enum([
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

const routeStopStatusEnum = z.enum([
  "PENDING",
  "ARRIVED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const routeIdParamSchema = z.object({
  routeId: z
    .string({ required_error: "ID da rota é obrigatório!" })
    .uuid("ID da rota é inválido."),
});

const routeStopIdParamSchema = z.object({
  stopId: z
    .string({ required_error: "ID da parada é obrigatório!" })
    .uuid("ID da parada é inválido."),
});

/**
 * A name is optional and free — dispatchers write "Zona Sul — manhã", not a
 * code. The code is allocated by the system and is what anybody quotes on the
 * phone.
 */
const routeNameField = z.preprocess(
  (value) => (value === "" ? null : value),
  z
    .string()
    .max(80, "O nome da rota deve ter no máximo 80 caracteres.")
    .nullable()
    .optional(),
);

const createRouteSchema = z.object({
  driverId: z
    .string({ required_error: "O motorista é obrigatório." })
    .uuid("O motorista deve ter um identificador válido.")
    .describe("Motorista ativo da mesma empresa."),
  vehicleId: z
    .string()
    .uuid("O veículo deve ter um identificador válido.")
    .nullable()
    .optional()
    .describe(
      "Opcional no planejamento; obrigatório para liberar a rota ao motorista.",
    ),
  name: routeNameField.describe("Rótulo livre, como “Zona Sul — manhã”."),
  scheduled_date: z.coerce
    .date({ required_error: "A data da rota é obrigatória." })
    .describe("O dia da operação."),
  planned_departure_at: z.coerce.date().nullable().optional(),
  planned_arrival_at: z.coerce.date().nullable().optional(),
  deliveryIds: z
    .array(z.string().uuid("Cada entrega deve ter um identificador válido."))
    .max(200, "Monte no máximo 200 paradas por rota.")
    .optional()
    .describe(
      "Entregas pendentes que viram paradas, na ordem enviada. Pode vir vazio: a rota nasce sem paradas e recebe depois.",
    ),
});

/**
 * Editing the plan, never the status — release, start and cancel are their own
 * endpoints because each carries rules an open-ended PATCH could not.
 *
 * Every field optional: this is a partial update, and an absent key means
 * "leave it" rather than "clear it". `null` is what clears.
 */
const updateRouteSchema = z
  .object({
    name: routeNameField,
    scheduled_date: z.coerce.date().optional(),
    planned_departure_at: z.coerce.date().nullable().optional(),
    planned_arrival_at: z.coerce.date().nullable().optional(),
    driverId: z
      .string()
      .uuid("O motorista deve ter um identificador válido.")
      .optional(),
    vehicleId: z
      .string()
      .uuid("O veículo deve ter um identificador válido.")
      .nullable()
      .optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Envie ao menos um campo para alterar.",
  );

const listRoutesSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  status: routeStatusEnum.optional().describe("Filtra por status da rota."),
  driverId: z
    .string()
    .uuid("ID do motorista é inválido.")
    .optional()
    .describe(
      "Ignorado para usuários motoristas: eles veem sempre e apenas as próprias rotas.",
    ),
  scheduled_date: z.coerce.date().optional().describe("Filtra pelo dia."),
});

const addRouteStopsSchema = z.object({
  deliveryIds: z
    .array(z.string().uuid("Cada entrega deve ter um identificador válido."), {
      required_error: "Selecione ao menos uma entrega para adicionar.",
    })
    .min(1, "Selecione ao menos uma entrega para adicionar.")
    .max(100, "Adicione no máximo 100 paradas por vez.")
    .describe("Entregas pendentes; entram no fim da ordem atual."),
});

const reorderRouteStopsSchema = z.object({
  orderedStopIds: z
    .array(z.string().uuid("Cada parada deve ter um identificador válido."), {
      required_error: "Envie a ordem completa das paradas.",
    })
    .min(1, "Envie a ordem completa das paradas.")
    .max(200, "Uma rota tem no máximo 200 paradas.")
    .describe(
      "A ordem COMPLETA, não um movimento. Uma lista que não descreva exatamente as paradas atuais da rota é recusada com 409 — é sinal de que a tela está desatualizada.",
    ),
});

const releaseRouteSchema = z.object({
  released: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "false devolve a rota ao planejamento, e só enquanto nenhuma parada foi trabalhada.",
    ),
});

const startRouteSchema = z.object({
  vehicleId: z
    .string()
    .uuid("O veículo deve ter um identificador válido.")
    .optional()
    .describe(
      "O veículo que o motorista está realmente levando. Ausente usa o da rota; outro é troca no pátio.",
    ),
});

const cancelRouteSchema = z.object({
  reason: z
    .string({ required_error: "Informe o motivo do cancelamento da rota." })
    .trim()
    .min(3, "O motivo deve ter no mínimo 3 caracteres.")
    .max(255, "O motivo deve ter no máximo 255 caracteres.")
    .describe(
      "Obrigatório: cancelar uma rota que já saiu joga fora a manhã de um motorista, e a única forma de alguém reconstruir o porquê é se quem cancelou disser na hora.",
    ),
});

export {
  addRouteStopsSchema,
  cancelRouteSchema,
  createRouteSchema,
  listRoutesSchema,
  releaseRouteSchema,
  reorderRouteStopsSchema,
  routeIdParamSchema,
  routeStatusEnum,
  routeStopIdParamSchema,
  routeStopStatusEnum,
  startRouteSchema,
  updateRouteSchema,
};
