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
 * the one route that carries a rate limit. A documented status nobody can
 * trigger is worse than an undocumented one — it sends a client down a branch
 * that never runs.
 */

/**
 * Prisma hands back `Date` objects and the zod serializer validates what the
 * handler actually passes, so a plain `z.string()` here rejects the route's
 * own real payload with a 500 — the documentation would be describing a
 * response the API cannot produce. Accepting both is what the wire carries:
 * `JSON.stringify` turns a Date into an ISO-8601 string. Same shape the
 * account-payable and driver documents already use.
 */
const isoDateTime = z.union([z.string(), z.date()]);

const routeStopEntity = z.object({
  id: z.string(),
  sequence: z.number().describe("Ordem manual, espaçada de dez."),
  status: routeStopStatusEnum,
  arrived_at: isoDateTime.nullable(),
  completed_at: isoDateTime.nullable(),
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
  scheduled_date: isoDateTime,
  planned_departure_at: isoDateTime.nullable(),
  planned_arrival_at: isoDateTime.nullable(),
  started_at: isoDateTime.nullable(),
  completed_at: isoDateTime.nullable(),
  cancellation_reason: z.string().nullable(),
  driverId: z.string(),
  vehicleId: z.string().nullable(),
  driver: z.object({ id: z.string(), name: z.string() }).nullable(),
  vehicle: z
    .object({ id: z.string(), license_plate: z.string() })
    .nullable(),
  stops: z.array(routeStopEntity),
  created_at: isoDateTime,
  updated_at: isoDateTime,
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
  /**
   * NOT a JSON object. This endpoint streams `application/x-ndjson`, like
   * every other offset listing in the API: one JSON value per line, the first
   * being the envelope below and each one after it a route.
   *
   * Documented as the envelope because that is the only part with a fixed
   * shape, and spelled out in the route's description because a client that
   * calls `response.json()` on this gets a parse error — which is exactly the
   * mistake a tidy-looking `{ data, total }` schema here would cause.
   *
   * Note `searchMeta`: sendAsNDJSON nests whatever the use case returned in
   * `meta` under that key, so the status tally is NOT at the top level.
   */
  routeListEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
      searchMeta: z.object({
        statusCounts: z
          .record(routeStatusEnum, z.number())
          .describe(
            "Contagem por status do conjunto FILTRADO, nunca da página — os cards descrevem o filtro, não a paginação. Todos os cinco status vêm sempre, inclusive zerados.",
          ),
      }),
    }),
  }),

  /** One line of the stream, after the envelope. */
  routeListRow: routeEntity,
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
    data: z.object({ id: z.string(), started_at: isoDateTime.nullable() }),
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
