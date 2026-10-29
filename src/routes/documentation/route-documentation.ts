import { z } from "zod";

import {
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
import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * What the API actually answers, not what would look tidy.
 *
 * Every status listed on a route below is one the code can really produce:
 * the 409s come from write preconditions that refuse rather than overwrite,
 * and the 404s cover "does not exist" AND "belongs to another company" because
 * the scoped reads cannot tell them apart on purpose. A documented status
 * nobody can trigger is worse than an undocumented one — it sends a client
 * down a branch that never runs.
 *
 * The convention: 400 when the body fails its schema (VALIDATION_ERROR, with
 * `issues`), 409 when the state forbids the write. 422 is not used here — six
 * routes once published it for validation, which is always a 400. The
 * refusals the hooks produce (401, 403, 429, 503) are added to every route by
 * openapi-transform, from the hooks themselves.
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
  on_the_way_at: isoDateTime
    .nullable()
    .describe(
      'Última vez que o motorista avisou estar a caminho desta parada (decisão 6.4); nulo se nunca avisou. Só a marcação mais recente da rota, com a parada ainda PENDING, vale como "a caminho".',
    ),
  arrived_at: isoDateTime.nullable(),
  completed_at: isoDateTime.nullable(),
  deliveryId: z.string(),
  delivery: z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    code: z.string().nullable().optional(),
    invoice_number: z.string().nullable().optional(),
    recipient_name: z.string(),
    city: z.string(),
    uf: z.string(),
    street: z.string(),
    address_number: z.string().nullable(),
    neighborhood: z.string().nullable(),
    latitude: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Onde fica o ENDEREÇO, para o mapa da rota (decisão 14.7). Nulo enquanto ninguém fixou o ponto. Não é o GPS do comprovante.",
      ),
    longitude: z.number().nullable().optional(),
    geo_source: z
      .enum(["MANUAL", "GEOCODER"])
      .nullable()
      .optional()
      .describe(
        "MANUAL: fixado no mapa pelo despachante; GEOCODER: resolvido pelo endereço.",
      ),
  }),
});

const routeEntity = z.object({
  id: z.string(),
  code: z.number().describe("Número sequencial por empresa."),
  name: z.string().nullable(),
  status: routeStatusEnum,
  scheduled_date: isoDateTime.describe(
    "Data civil (sem hora): meia-noite UTC do dia. Leia o dia em UTC.",
  ),
  destination: z
    .string()
    .nullable()
    .describe("Para onde a rota vai, em texto livre."),
  planned_departure_at: isoDateTime.nullable(),
  planned_arrival_at: isoDateTime.nullable(),
  started_at: isoDateTime.nullable(),
  completed_at: isoDateTime.nullable(),
  cancellation_reason: z.string().nullable(),
  driverId: z.string(),
  vehicleId: z.string().nullable(),
  driver: z.object({ id: z.string(), name: z.string() }).nullable(),
  vehicle: z.object({ id: z.string(), license_plate: z.string() }).nullable(),
  stops: z.array(routeStopEntity),
  plan_version: z
    .number()
    .describe(
      "Versão do plano (decisão 14.7): sobe a cada parada adicionada, removida ou reordenada, ponto fixado e edição de motorista, veículo ou janela. Envie de volta como `expectedPlanVersion` para não sobrescrever a mudança de um colega.",
    ),
  released_at: isoDateTime
    .nullable()
    .describe(
      "Quando a rota foi liberada ao motorista; nulo enquanto rascunho.",
    ),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const driverPositionEntity = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    speed: z.number().nullable(),
    heading: z.number().nullable(),
    recordedAt: z.string().describe("Instante ISO 8601 do ponto."),
    fresh: z
      .boolean()
      .describe("Ponto dos últimos 10 minutos (a mesma regra da torre)."),
  })
  .nullable()
  .describe(
    "Onde está o motorista DESTA rota: só em rota liberada ou em andamento, e só um ponto gravado nela — nunca o de outra rota do mesmo motorista. Nulo para o aplicativo do motorista.",
  );

const visitedPointEntity = z.object({
  deliveryId: z.string(),
  type: z.enum(["ARRIVAL", "PROOF"]),
  latitude: z.number(),
  longitude: z.number(),
  recordedAt: isoDateTime,
});

const unroutedDeliveryRow = z.object({
  id: z.string(),
  code: z.string().nullable(),
  kind: z.string(),
  invoice_number: z.string().nullable(),
  recipient_name: z.string(),
  street: z.string(),
  address_number: z.string().nullable(),
  neighborhood: z.string().nullable(),
  city: z.string(),
  uf: z.string(),
  scheduled_date: isoDateTime
    .nullable()
    .describe("Data civil (meia-noite UTC do dia), ou nula."),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  shipper: z.object({ id: z.string(), name: z.string() }).nullable(),
});

const facetCount = z.object({ value: z.string(), count: z.number() });

const routeSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  routeBusinessParams: updateDeleteBusinessSchema.merge(routeIdParamSchema),
  routeStopParams: updateDeleteBusinessSchema
    .merge(routeIdParamSchema)
    .merge(routeStopIdParamSchema),
  deliveryLocationParams: updateDeleteBusinessSchema.merge(
    deliveryIdParamSchema,
  ),

  removeStops: removeRouteStopsSchema,
  moveStops: moveRouteStopsSchema,
  setDeliveryLocation: setDeliveryLocationSchema,
  listUnroutedDeliveries: listUnroutedDeliveriesSchema,
  openStops: openStopsQuerySchema,

  createRoute: createRouteSchema,
  updateRoute: updateRouteSchema,
  listRoutes: listRoutesSchema,

  addStops: addRouteStopsSchema,
  reorderStops: reorderRouteStopsSchema,

  releaseRoute: releaseRouteSchema,
  startRoute: startRouteSchema,
  cancelRoute: cancelRouteSchema,

  assignmentPreview: assignmentPreviewSchema,
};

const assignmentVehicle = z.object({
  id: z.string(),
  license_plate: z.string(),
  description: z.string().nullable(),
  status: z.string().describe("ACTIVE, IN_ROUTE, INACTIVE ou BLOCKED."),
});

// The operation's live surfaces (positions, tower, trail, monitoring) are
// documented in control-tower-documentation.ts.
const routeResponses = {
  routeCreated: z.object({
    message: z.string().default("Rota criada com sucesso!"),
    data: z.object({
      id: z.string(),
      code: z.number(),
      stops: z.number(),
      planVersion: z.number(),
      replayed: z
        .boolean()
        .describe(
          "true quando o `Idempotency-Key` já tinha criado esta rota: nada foi gravado de novo.",
        ),
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
      total: z
        .number()
        .describe(
          "Rotas da busca com TODOS os filtros aplicados: desenha o paginador.",
        ),
      page: z.number(),
      pageSize: z.number(),
      searchMeta: searchMetaDoc(
        {
          statusCounts: z
            .record(routeStatusEnum, z.number())
            .describe(
              "Rotas por status com a busca e os demais filtros, sem o de status (os cartões). Nunca da página; os cinco status vêm sempre, inclusive zerados.",
            ),
        },
        ["status", "driverId", "vehicleId"],
      ),
    }),
  }),

  /** One line of the stream, after the envelope. */
  routeListRow: routeEntity,
  routeDetail: z.object({
    data: routeEntity.extend({
      driverPosition: driverPositionEntity,
      visitedPoints: z
        .array(visitedPointEntity)
        .describe(
          "GPS capturado na chegada e no comprovante das paradas desta rota, para o mapa.",
        ),
    }),
    meta: z.object({
      progress: z.object({
        done: z
          .number()
          .describe("Paradas já resolvidas, de qualquer desfecho."),
        total: z.number(),
      }),
    }),
  }),
  routeReleased: z.object({
    message: z.string(),
    data: z.object({
      unchanged: z
        .boolean()
        .describe(
          "true quando a rota já estava no estado pedido (duplo clique, reenvio): nada foi gravado.",
        ),
      status: routeStatusEnum,
      planVersion: z.number(),
    }),
  }),
  routeStarted: z.object({
    message: z.string().default("Rota iniciada!"),
    data: z.object({ id: z.string(), started_at: isoDateTime.nullable() }),
  }),
  routeCancelled: z.object({ message: z.string().default("Rota cancelada.") }),

  assignmentPreview: z.object({
    data: z.object({
      scheduled_date: z.string().describe("O dia avaliado, AAAA-MM-DD."),
      timeZone: z
        .string()
        .describe(
          "Fuso da empresa (IANA, `Business.timezone`). É nele que a saída prevista precisa cair no dia da rota.",
        ),
      driver: z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
      }),
      responsibleVehicles: z
        .array(assignmentVehicle)
        .describe(
          "Veículos em operação dos quais o motorista é o responsável (cadastro do veículo).",
        ),
      suggestedVehicleId: z
        .string()
        .nullable()
        .describe(
          "O único veículo sob responsabilidade do motorista, para pré-selecionar; null se nenhum ou mais de um.",
        ),
      vehicle: assignmentVehicle
        .extend({
          responsible: z
            .object({ id: z.string(), name: z.string() })
            .nullable(),
        })
        .nullable(),
      warnings: z
        .array(
          z.object({
            code: z
              .string()
              .describe(
                "DRIVER_ON_ROUTE, DRIVER_BOOKED_ON_DAY, DRIVER_CNH_EXPIRED, DRIVER_CNH_INCOMPATIBLE, DRIVER_CNH_CATEGORY_UNKNOWN, VEHICLE_OUT_OF_OPERATION, VEHICLE_IN_ROUTE, VEHICLE_OTHER_RESPONSIBLE, VEHICLE_BOOKED_ON_DAY, VEHICLE_OPEN_SERVICE_ORDER ou VEHICLE_CHECKLIST_REJECTED. Uma string, não uma lista fechada: um aviso novo não pode quebrar o cliente.",
              ),
            message: z.string(),
          }),
        )
        .describe("Avisos que não bloqueiam a atribuição."),
    }),
  }),
  stopsAdded: z.object({
    message: z.string().default("Paradas adicionadas à rota!"),
    data: z.object({
      added: z.number(),
      stopIds: z.array(z.string()),
      alreadyOnRoute: z
        .array(z.string())
        .describe(
          "Entregas que já eram paradas abertas DESTA rota: o reenvio depois de uma resposta perdida, respondido como sucesso.",
        ),
      planVersion: z.number(),
    }),
  }),
  stopRemoved: z.object({
    message: z.string().default("Parada removida da rota."),
  }),
  stopsRemoved: z.object({
    message: z.string(),
    data: z.object({
      removed: z.array(z.string()).describe("Paradas retiradas."),
      alreadyGone: z
        .array(z.string())
        .describe(
          "Ids que não são (ou já não eram) paradas pendentes desta rota: o reenvio não é erro.",
        ),
      planVersion: z.number(),
      routeEmptied: z
        .boolean()
        .describe(
          "A rota ficou sem parada aberta. Uma rota liberada NÃO é cancelada aqui: a tela oferece voltar ao planejamento ou cancelar.",
        ),
    }),
  }),
  stopsMoved: z.object({
    message: z.string(),
    data: z.object({
      added: z.number(),
      stopIds: z.array(z.string()),
      moved: z.array(
        z.object({
          deliveryId: z.string(),
          fromRouteId: z.string(),
          fromRouteCode: z.number(),
        }),
      ),
      alreadyOnRoute: z.array(z.string()),
      cancelledRoutes: z
        .array(z.number())
        .describe(
          "Códigos das rotas LIBERADAS que ficaram vazias e foram canceladas (o motorista é avisado).",
        ),
      planVersion: z.number(),
    }),
  }),
  stopsReordered: z.object({
    message: z.string().default("Ordem das paradas atualizada."),
    data: z.object({ planVersion: z.number() }),
  }),
  deliveryLocation: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      geo_source: z.enum(["MANUAL", "GEOCODER"]).nullable(),
      geo_updated_at: isoDateTime.nullable(),
      routeId: z
        .string()
        .nullable()
        .describe(
          "A rota PLANNED/RELEASED que tem a entrega como parada; nulo quando nenhuma.",
        ),
      planVersion: z
        .number()
        .nullable()
        .describe(
          "A nova versão do plano dessa rota (o ponto faz parte do plano); nulo sem rota.",
        ),
    }),
  }),
  unroutedDeliveries: z.object({
    data: z.array(unroutedDeliveryRow),
    meta: z.object({
      total: z
        .number()
        .describe("Entregas sem rota com a busca e TODOS os filtros."),
      page: z.number(),
      pageSize: z.number(),
      facets: z
        .object({
          city: z.array(facetCount),
          uf: z.array(facetCount),
          kind: z.array(facetCount),
          shipper: z
            .array(
              facetCount.extend({
                label: z.string().describe("Nome do embarcador."),
              }),
            )
            .describe(
              "`value` é o id do embarcador (filtro `shipperIds`); no máximo 50, os com mais entregas.",
            ),
        })
        .describe(
          "Opções de cada filtro com a busca e os DEMAIS filtros (regra disjuntiva). Cidades e embarcadores: no máximo 50.",
        ),
    }),
  }),
  openStops: z.object({
    data: z.array(
      z.object({
        deliveryId: z.string(),
        stopId: z.string(),
        routeId: z.string(),
        routeCode: z.number(),
        routeStatus: routeStatusEnum,
      }),
    ),
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
  /**
   * A 404 that names its codes. Every one of them means "not here for you":
   * another company's id answers exactly like a missing one.
   */
  notFound: (codes: string) =>
    z
      .object({ code: z.string().describe(codes), message: z.string() })
      .describe(codes),
  // A string and not an enum: a closed list here documents the codes of
  // today as the only ones, and a new conflict code is exactly the kind of
  // change a client must survive by refreshing, not by failing to parse.
  conflictError: z.object({
    code: z
      .string()
      .describe(
        "ROUTE_STATUS_CONFLICT, ROUTE_VEHICLE_BUSY, DELIVERY_ALREADY_ON_ROUTE, ROUTE_REORDER_MISMATCH ou ROUTE_PLAN_STALE (a versão do plano mudou desde a leitura) significam a mesma ação do usuário: atualizar a tela. ROUTE_DRIVER_BUSY (saída) diz que o motorista já está com outra rota em andamento; DELIVERY_ON_STARTED_ROUTE, que a entrega está numa rota que já saiu. ROUTE_CODE_TAKEN (criação simultânea na mesma empresa, raro): basta reenviar. Nada foi gravado.",
      ),
    message: z.string(),
  }),
  internalServerError: z.object({
    code: z.string().default("INTERNAL_ERROR"),
    message: z.string().default("Internal server error"),
  }),
};

export { routeSchemas, routeResponses };
