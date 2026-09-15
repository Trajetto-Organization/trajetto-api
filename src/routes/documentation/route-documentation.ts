import { z } from "zod";

import {
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
} from "@/schemas/route-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/**
 * What the API actually answers, not what would look tidy.
 *
 * Every status listed on a route below is one the code can really produce:
 * the 409s come from write preconditions that refuse rather than overwrite,
 * the 404s cover "does not exist" AND "belongs to another company" because the
 * scoped reads cannot tell them apart on purpose, and the 429 appears only on
 * the two routes that carry a rate limit. A documented status nobody can
 * trigger is worse than an undocumented one — it sends a client down a branch
 * that never runs.
 */
const routeStopEntity = z.object({
  id: z.string(),
  sequence: z.number().describe("Ordem manual, espaçada de dez."),
  status: routeStopStatusEnum,
  arrived_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  deliveryId: z.string(),
  delivery: z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    recipient_name: z.string(),
    city: z.string(),
    uf: z.string(),
    street: z.string(),
    address_number: z.string().nullable(),
    neighborhood: z.string().nullable(),
  }),
});

const routeEntity = z.object({
  id: z.string(),
  code: z.number().describe("Número sequencial por empresa."),
  name: z.string().nullable(),
  status: routeStatusEnum,
  scheduled_date: z.string(),
  planned_departure_at: z.string().nullable(),
  planned_arrival_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  driverId: z.string(),
  vehicleId: z.string().nullable(),
  driver: z.object({ id: z.string(), name: z.string() }).nullable(),
  vehicle: z
    .object({ id: z.string(), license_plate: z.string() })
    .nullable(),
  stops: z.array(routeStopEntity),
  created_at: z.string(),
  updated_at: z.string(),
});

const routeSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  routeBusinessParams: updateDeleteBusinessSchema.merge(routeIdParamSchema),
  routeStopParams: updateDeleteBusinessSchema
    .merge(routeIdParamSchema)
    .merge(routeStopIdParamSchema),

  createRoute: createRouteSchema,
  updateRoute: updateRouteSchema,
  listRoutes: listRoutesSchema,

  addStops: addRouteStopsSchema,
  reorderStops: reorderRouteStopsSchema,

  releaseRoute: releaseRouteSchema,
  startRoute: startRouteSchema,
  cancelRoute: cancelRouteSchema,
};

const routeResponses = {
  routeCreated: z.object({
    message: z.string().default("Rota criada com sucesso!"),
    data: z.object({
      id: z.string(),
      code: z.number(),
      stops: z.number(),
    }),
  }),
  routeUpdated: z.object({
    message: z.string().default("Rota atualizada com sucesso!"),
  }),
  routeList: z.object({
    data: z.array(routeEntity),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
    meta: z.object({
      statusCounts: z.record(routeStatusEnum, z.number()).describe(
        "Contagem por status do conjunto FILTRADO, nunca da página — os cards descrevem o filtro, não a paginação.",
      ),
    }),
  }),
  routeDetail: z.object({
    data: routeEntity,
    meta: z.object({
      progress: z.object({
        done: z.number().describe("Paradas já resolvidas, de qualquer desfecho."),
        total: z.number(),
      }),
    }),
  }),
  routeReleased: z.object({ message: z.string() }),
  routeStarted: z.object({
    message: z.string().default("Rota iniciada!"),
    data: z.object({ id: z.string(), started_at: z.string().nullable() }),
  }),
  routeCancelled: z.object({ message: z.string().default("Rota cancelada.") }),

  stopsAdded: z.object({
    message: z.string().default("Paradas adicionadas à rota!"),
    data: z.object({ added: z.number() }),
  }),
  stopRemoved: z.object({
    message: z.string().default("Parada removida da rota."),
  }),
  stopsReordered: z.object({
    message: z.string().default("Ordem das paradas atualizada."),
  }),

  /**
   * Every refusal carries a machine-readable `code` alongside the message, and
   * the header `x-error-code` repeats it. The frontend switches on the code;
   * the message is what the operator reads.
   */
  genericError: z.object({
    code: z.string(),
    message: z.string(),
  }),
  conflictError: z.object({
    code: z
      .enum([
        "ROUTE_STATUS_CONFLICT",
        "ROUTE_VEHICLE_BUSY",
        "DELIVERY_ALREADY_ON_ROUTE",
        "ROUTE_REORDER_MISMATCH",
      ])
      .describe(
        "Todos significam a mesma ação do usuário: atualizar a tela. Nada foi gravado.",
      ),
    message: z.string(),
  }),
  validationError: z.object({
    code: z.string().default("VALIDATION_ERROR"),
    message: z.string().default("Validation Error"),
    issues: z.array(z.string()),
  }),
  internalServerError: z.object({
    code: z.string().default("INTERNAL_ERROR"),
    message: z.string().default("Internal server error"),
  }),
};

export { routeSchemas, routeResponses };
