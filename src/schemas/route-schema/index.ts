import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { occurredAtField } from "@/shared/delivery/occurred-at";
import { DELIVERY_KINDS } from "@/shared/delivery/delivery-kind";
import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  ROUTE_LIST_STATUSES,
  ROUTE_SORT_FALLBACK,
  ROUTE_SORT_KEYS,
} from "@/modules/route/usecases/list-routes/route-list";

import {
  ROUTE_DESTINATION_MAX,
  ROUTE_NAME_MAX,
  windowOrderIssues,
} from "@/shared/route/route-plan-rules";
import { dateOnlyFromKey, dateOnlyKey } from "@/shared/time/business-day";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

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
 * An optional free text under the product's text rules (no blank-only value,
 * no spaces at the edges, no runs of spaces), the same three refusals the web
 * gives, message for message. `""` is what an empty input posts and means
 * "none" (`null`).
 */
const optionalRouteText = (label: string, max: number) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    z
      .string({ invalid_type_error: `${label} deve ser um texto.` })
      .max(max, `${label} deve ter no máximo ${max} caracteres.`)
      .superRefine((value, ctx) => {
        if (isEmptyOrWhitespace(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não pode conter apenas espaços.`,
          });

          return;
        }

        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não deve conter espaços consecutivos.`,
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não pode começar ou terminar com espaço em branco.`,
          });
        }
      })
      .nullable()
      .optional(),
  );

/**
 * A name is optional and free — dispatchers write "Zona Sul — manhã", not a
 * code. The code is allocated by the system and is what anybody quotes on the
 * phone.
 */
const routeNameField = optionalRouteText("O nome da rota", ROUTE_NAME_MAX);

/** Where the route is headed ("CD Cajamar"). Decision 6.5. */
const routeDestinationField = optionalRouteText(
  "O destino",
  ROUTE_DESTINATION_MAX,
);

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isValidDateKey = (value: string): boolean => {
  try {
    dateOnlyFromKey(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * The route's day: a civil date, "YYYY-MM-DD" (decision 1.3), stored as UTC
 * midnight. An instant is refused rather than guessed: "2026-09-17T23:30-03:00"
 * is the 18th in UTC, and truncating it is how a route moved a day.
 *
 * The Date a first parse produced is accepted back as its own key, because
 * Fastify's validator hands the controller the parsed body and the controller
 * parses it again.
 */
const routeDayField = (required: string) =>
  z.preprocess(
    (value) => (value instanceof Date ? dateOnlyKey(value) : value),
    z
      .string({ required_error: required, invalid_type_error: required })
      // One refusal per value: a wrong shape is not ALSO an invalid day.
      .superRefine((value, ctx) => {
        if (!DATE_KEY.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A data da rota deve estar no formato AAAA-MM-DD.",
          });

          return;
        }

        if (!isValidDateKey(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A data da rota é inválida.",
          });
        }
      })
      .transform((value) => dateOnlyFromKey(value)),
  );

/**
 * A planned instant: ISO 8601 WITH an offset (decision 1.4). A wall time
 * without one ("2026-09-17T08:00") used to be read in the server's zone —
 * UTC in the container — and every planned time landed three hours early.
 * `""` and `null` clear it; the re-parse accepts its own Date back.
 */
const plannedInstantField = (label: string) =>
  z.preprocess(
    (value) =>
      value === "" ? null : value instanceof Date ? value.toISOString() : value,
    z
      .string({ invalid_type_error: `${label} deve ser uma data e hora.` })
      .datetime({
        offset: true,
        message: `${label} deve ter data, hora e fuso (ex.: 2026-09-17T08:00:00-03:00).`,
      })
      .transform((value) => new Date(value))
      .nullable()
      .optional(),
  );

/** The window's order, the half of the plan rules that needs no zone. */
const refineWindowOrder = (
  body: {
    planned_departure_at?: Date | null;
    planned_arrival_at?: Date | null;
  },
  ctx: z.RefinementCtx,
): void => {
  for (const issue of windowOrderIssues(
    body.planned_departure_at,
    body.planned_arrival_at,
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [issue.field],
      message: issue.message,
    });
  }
};

const routePlanFields = {
  name: routeNameField.describe("Rótulo livre, como “Zona Sul — manhã”."),
  destination: routeDestinationField.describe(
    "Para onde a rota vai, em texto livre (até 160 caracteres), como “CD Cajamar”.",
  ),
  planned_departure_at: plannedInstantField("A saída prevista").describe(
    "ISO 8601 com fuso. Deve cair no dia da rota, no fuso da empresa.",
  ),
  planned_arrival_at: plannedInstantField("O retorno previsto").describe(
    "ISO 8601 com fuso. Igual ou posterior à saída prevista.",
  ),
};

/**
 * The plan version the dispatcher read (decision 14.7, D5). Optional, so a
 * client that does not send it keeps the old contract; sent, a mismatch is
 * 409 ROUTE_PLAN_STALE.
 */
const expectedPlanVersionField = z
  .number({ invalid_type_error: "A versão da rota deve ser um número." })
  .int("A versão da rota deve ser um número inteiro.")
  .min(0, "A versão da rota não pode ser negativa.")
  .optional()
  .describe(
    "A `plan_version` que a tela leu. Diferente da atual: 409 ROUTE_PLAN_STALE e nada é gravado.",
  );

const createRouteSchema = z
  .object({
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
    ...routePlanFields,
    scheduled_date: routeDayField("A data da rota é obrigatória.").describe(
      "O dia da operação, AAAA-MM-DD.",
    ),
    deliveryIds: z
      .array(z.string().uuid("Cada entrega deve ter um identificador válido."))
      .max(200, "Monte no máximo 200 paradas por rota.")
      .optional()
      .describe(
        "Entregas pendentes que viram paradas, na ordem enviada. Pode vir vazio: a rota nasce sem paradas e recebe depois.",
      ),
  })
  .superRefine(refineWindowOrder);

/**
 * Editing the plan, never the status — release, start and cancel are their own
 * endpoints because each carries rules an open-ended PATCH could not.
 *
 * Every field optional: this is a partial update, and an absent key means
 * "leave it" rather than "clear it". `null` is what clears. The window is
 * checked here when both ends come in the body, and by the use case against
 * the stored values otherwise.
 */
const updateRouteSchema = z
  .object({
    ...tenantLockedShape,
    ...routePlanFields,
    scheduled_date: routeDayField("A data da rota é inválida.").optional(),
    driverId: z
      .string()
      .uuid("O motorista deve ter um identificador válido.")
      .optional(),
    vehicleId: z
      .string()
      .uuid("O veículo deve ter um identificador válido.")
      .nullable()
      .optional(),
    expectedPlanVersion: expectedPlanVersionField,
  })
  .superRefine(refineWindowOrder)
  .refine(
    // The version is a guard, not a change: alone it edits nothing.
    ({ expectedPlanVersion: _version, ...body }) =>
      Object.values(body).some((value) => value !== undefined),
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
  ...sortFields(ROUTE_SORT_KEYS, ROUTE_SORT_FALLBACK),
  status: facetField(ROUTE_LIST_STATUSES, "Status da rota."),
  driverId: idFacetField(
    "Motoristas. Ignorado para usuários motoristas: eles veem sempre e apenas as próprias rotas.",
  ),
  vehicleId: idFacetField("Veículos."),
  scheduled_date: routeDayField("A data da rota é inválida.")
    .optional()
    .describe("Filtra pelo dia, AAAA-MM-DD."),
  search: z
    .string()
    .optional()
    .describe(
      "Nome da rota, destino, nome do motorista ou código (“12”, “Rota 12”, “#12”). Números longos, como uma chave de NF-e, não são lidos como código.",
    ),
});

/** The pair the assignment dialog is about to choose (FLEET-ASSIGN-2). */
const assignmentPreviewSchema = z.object({
  driverId: z
    .string({ required_error: "O motorista é obrigatório." })
    .uuid("O motorista deve ter um identificador válido.")
    .describe("Motorista da mesma empresa."),
  vehicleId: z
    .string()
    .uuid("O veículo deve ter um identificador válido.")
    .optional()
    .describe("Veículo em avaliação, quando já escolhido."),
  scheduled_date: routeDayField("A data da rota é inválida.")
    .optional()
    .describe("O dia da rota, AAAA-MM-DD. Ausente, hoje no fuso da empresa."),
  excludeRouteId: z
    .string()
    .uuid("ID da rota é inválido.")
    .optional()
    .describe("A rota em edição: as linhas dela não contam como conflito."),
  deliveryIds: z
    .preprocess(
      // "a,b" or the repeated form (?deliveryIds=a&deliveryIds=b).
      (raw) =>
        raw === undefined || raw === ""
          ? undefined
          : (Array.isArray(raw) ? raw : [raw])
              .flatMap((value) => String(value).split(","))
              .map((value) => value.trim())
              .filter(Boolean),
      z
        .array(
          z.string().uuid("Cada entrega deve ter um identificador válido."),
        )
        .max(100, "Envie no máximo 100 entregas.")
        .optional(),
    )
    .describe(
      "A seleção da atribuição em lote (IDs separados por vírgula, até 100): uma rota liberada que ela esvaziaria — e que a atribuição cancela — não conta como conflito.",
    ),
});

const addRouteStopsSchema = z.object({
  ...tenantLockedShape,
  deliveryIds: z
    .array(z.string().uuid("Cada entrega deve ter um identificador válido."), {
      required_error: "Selecione ao menos uma entrega para adicionar.",
    })
    .min(1, "Selecione ao menos uma entrega para adicionar.")
    .max(100, "Adicione no máximo 100 paradas por vez.")
    .describe("Entregas pendentes; entram no fim da ordem atual."),
  expectedPlanVersion: expectedPlanVersionField,
});

/** Several stops off the plan at once (decision 14.7, §4.4). */
const removeRouteStopsSchema = z.object({
  ...tenantLockedShape,
  stopIds: z
    .array(z.string().uuid("Cada parada deve ter um identificador válido."), {
      required_error: "Selecione ao menos uma parada para remover.",
    })
    .min(1, "Selecione ao menos uma parada para remover.")
    .max(200, "Remova no máximo 200 paradas por vez.")
    .describe("Paradas PENDING desta rota."),
  expectedPlanVersion: expectedPlanVersionField,
});

/**
 * Deliveries brought to this route, from another editable route or from no
 * route, in one transaction (decision 14.7, D10).
 */
const moveRouteStopsSchema = z.object({
  ...tenantLockedShape,
  deliveryIds: z
    .array(z.string().uuid("Cada entrega deve ter um identificador válido."), {
      required_error: "Selecione ao menos uma entrega para mover.",
    })
    .min(1, "Selecione ao menos uma entrega para mover.")
    .max(100, "Mova no máximo 100 entregas por vez.")
    .describe(
      "Entregas pendentes, em outra rota ainda não iniciada ou sem rota; entram no fim da ordem desta.",
    ),
  expectedPlanVersion: expectedPlanVersionField,
});

/** Where the delivery's address is, pinned by hand on the route map (D7). */
const setDeliveryLocationSchema = z
  .object({
    ...tenantLockedShape,
    latitude: z
      .number({ invalid_type_error: "A latitude deve ser um número." })
      .min(-90, "Latitude inválida.")
      .max(90, "Latitude inválida.")
      .optional(),
    longitude: z
      .number({ invalid_type_error: "A longitude deve ser um número." })
      .min(-180, "Longitude inválida.")
      .max(180, "Longitude inválida.")
      .optional(),
    clear: z
      .literal(true)
      .optional()
      .describe("true apaga o ponto: a entrega volta a ficar sem localização."),
  })
  .superRefine((body, ctx) => {
    const hasPoint =
      body.latitude !== undefined || body.longitude !== undefined;

    if (body.clear && hasPoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Envie o ponto ou clear, não os dois.",
      });

      return;
    }

    if (
      !body.clear &&
      (body.latitude === undefined || body.longitude === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe a latitude e a longitude do endereço.",
      });
    }
  });

const deliveryIdParamSchema = z.object({
  deliveryId: z
    .string({ required_error: "ID da entrega é obrigatório!" })
    .uuid("ID da entrega é inválido."),
});

/** A comma list or the repeated form, trimmed, empty dropped. */
const listParam = <T extends z.ZodTypeAny>(
  item: T,
  max: number,
  label: string,
) =>
  z.preprocess(
    (raw) =>
      raw === undefined || raw === ""
        ? undefined
        : (Array.isArray(raw) ? raw : [raw])
            .flatMap((value) => String(value).split(","))
            .map((value) => value.trim())
            .filter(Boolean),
    z.array(item).max(max, `Envie no máximo ${max} ${label}.`).optional(),
  );

/** The "Adicionar entregas" picker (decision 14.7, §5.5). */
const listUnroutedDeliveriesSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Página, a partir de 1."),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100, "No máximo 100 por página.")
    .default(50)
    .describe("Itens por página (até 100)."),
  search: z
    .string()
    .max(120, "A busca deve ter no máximo 120 caracteres.")
    .optional()
    .describe("Código, número da NF, chave, destinatário, cidade ou rua."),
  shipperIds: listParam(
    z.string().uuid("Embarcador inválido."),
    50,
    "embarcadores",
  ).describe("Embarcadores (IDs separados por vírgula)."),
  cities: listParam(z.string().max(120), 50, "cidades").describe(
    "Cidades, sem diferenciar maiúsculas.",
  ),
  ufs: listParam(
    z.string().regex(/^[A-Za-z]{2}$/, "UF inválida."),
    27,
    "UFs",
  ).describe("UFs (duas letras)."),
  kinds: listParam(
    z.enum(DELIVERY_KINDS),
    DELIVERY_KINDS.length,
    "tipos",
  ).describe(
    "DELIVERY (entrega), SERVICE_ORDER (ordem de serviço) e/ou PICKUP (coleta).",
  ),
  scheduledFrom: routeDayField("A data inicial é inválida.")
    .optional()
    .describe("Data prevista a partir de (AAAA-MM-DD)."),
  scheduledTo: routeDayField("A data final é inválida.")
    .optional()
    .describe("Data prevista até (AAAA-MM-DD), inclusive."),
  // The boolean branch accepts the first parse's own output back: Fastify's
  // validator replaces request.query with it and the controller parses again.
  includeUnscheduled: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((value) => value === "true"),
    ])
    .optional()
    .describe(
      "Com um intervalo de datas, true inclui também as entregas sem data prevista. Sem intervalo, false esconde as sem data.",
    ),
});

/** Where a selection of deliveries is now (the "Adicionar à rota" dialog). */
const openStopsQuerySchema = z.object({
  deliveryIds: listParam(
    z.string().uuid("Cada entrega deve ter um identificador válido."),
    100,
    "entregas",
  ).describe("Até 100 IDs separados por vírgula."),
});

const reorderRouteStopsSchema = z.object({
  ...tenantLockedShape,
  orderedStopIds: z
    .array(z.string().uuid("Cada parada deve ter um identificador válido."), {
      required_error: "Envie a ordem completa das paradas.",
    })
    .min(1, "Envie a ordem completa das paradas.")
    .max(200, "Uma rota tem no máximo 200 paradas.")
    .describe(
      "A ordem COMPLETA, não um movimento. Uma lista que não descreva exatamente as paradas atuais da rota é recusada com 409 — é sinal de que a tela está desatualizada.",
    ),
  expectedPlanVersion: expectedPlanVersionField,
});

const releaseRouteSchema = z.object({
  ...tenantLockedShape,
  released: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "false devolve a rota ao planejamento, e só enquanto nenhuma parada foi trabalhada.",
    ),
  expectedPlanVersion: expectedPlanVersionField,
});

const startRouteSchema = z.object({
  ...tenantLockedShape,
  vehicleId: z
    .string()
    .uuid("O veículo deve ter um identificador válido.")
    .optional()
    .describe(
      "O veículo que o motorista está realmente levando. Ausente usa o da rota; outro é troca no pátio.",
    ),
  occurred_at: occurredAtField,
});

const cancelRouteSchema = z.object({
  ...tenantLockedShape,
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
  deliveryIdParamSchema,
  listUnroutedDeliveriesSchema,
  moveRouteStopsSchema,
  openStopsQuerySchema,
  removeRouteStopsSchema,
  setDeliveryLocationSchema,
  addRouteStopsSchema,
  assignmentPreviewSchema,
  cancelRouteSchema,
  createRouteSchema,
  listRoutesSchema,
  plannedInstantField,
  refineWindowOrder,
  releaseRouteSchema,
  reorderRouteStopsSchema,
  routeDayField,
  routeDestinationField,
  routeIdParamSchema,
  routeStatusEnum,
  routeStopIdParamSchema,
  routeStopStatusEnum,
  startRouteSchema,
  updateRouteSchema,
};
