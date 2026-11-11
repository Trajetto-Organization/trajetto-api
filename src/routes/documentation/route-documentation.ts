import { z } from "zod";
import { responseDateTime } from "./response-date";

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
  closeRouteWithPendingSchema,
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
import { FUEL_ALERTS } from "@/modules/fuel/usecases/list-fuel/fuel-list";

/**
 * A count per status, every status always there (zeros included). Spelled
 * out as an object: zod 4 writes a record keyed by an enum without its keys
 * in an OpenAPI 3.0 document.
 */
function countsPer(statuses: { options: readonly string[] }) {
  return z.object(
    Object.fromEntries(statuses.options.map((status) => [status, z.number()])),
  );
}

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
const routeStopEntity = z.object({
  id: z.string(),
  sequence: z.number().describe("Ordem manual, espaçada de dez."),
  status: routeStopStatusEnum,
  on_the_way_at: responseDateTime()
    .nullable()
    .describe(
      'Última vez que o motorista avisou estar a caminho desta parada (decisão 6.4); nulo se nunca avisou. Só a marcação mais recente da rota, com a parada ainda PENDING, vale como "a caminho".',
    ),
  arrived_at: responseDateTime().nullable(),
  completed_at: responseDateTime().nullable(),
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
        "MANUAL: fixado no mapa pelo despachante ou informado na criação (formulário, planilha ou API pública); GEOCODER: resolvido pelo endereço.",
      ),
    geo_precision: z
      .enum(["ADDRESS", "STREET", "NEIGHBORHOOD", "CITY"])
      .nullable()
      .optional()
      .describe(
        "Até onde o geocodificador chegou (plano de 02/11/2026, E1): ADDRESS (o número) ou STREET (a rua) têm ponto; NEIGHBORHOOD ou CITY ficam sem ponto (não avaliável). Nulo num ponto MANUAL (mesmo fixado sobre um ponto achado pelo endereço), enquanto o endereço não foi procurado e depois de apagado à mão um ponto que o geocodificador tinha achado.",
      ),
    address_lookup: z
      .enum(["SEARCHING", "NOT_LOCATED"])
      .nullable()
      .optional()
      .describe(
        'Só na consulta da rota (get-route), para a parada sem ponto: SEARCHING enquanto uma busca está em andamento ou é iminente — o endereço foi gravado (criado ou editado) ou reservado pelo geocodificador há menos de 10 min, ainda sem resposta, e as buscas não estão suspensas ("Localizando endereço…"); NOT_LOCATED quando a busca terminou sem ponto (endereço não encontrado, só bairro ou cidade, ou todas as tentativas gastas; "Endereço não localizado — fixe no mapa"). Nulo quando a parada tem ponto, quando o servidor não procura endereços (sem REVERSE_GEOCODER_URL ou orçamento 0), na entrega encerrada, depois de apagado à mão um ponto que o geocodificador tinha achado, com as buscas suspensas (provedor recusando a chave ou a URL, cota do dia do provedor ou orçamento do dia gastos), depois de uma falha do provedor que espera a próxima tentativa, e quando nada pediu o endereço nos últimos 10 min. Um ponto achado depois ainda chega à tela (evento routeStopsLocated). O "Fixar no mapa" vale em todos os casos. Ausente em API anterior.',
      ),
  }),
});

const routeEntity = z.object({
  id: z.string(),
  code: z.number().describe("Número sequencial por empresa."),
  name: z.string().nullable(),
  status: routeStatusEnum,
  scheduled_date: responseDateTime().describe(
    "Data civil (sem hora): meia-noite UTC do dia. Leia o dia em UTC.",
  ),
  destination: z
    .string()
    .nullable()
    .describe("Para onde a rota vai, em texto livre."),
  planned_departure_at: responseDateTime().nullable(),
  planned_arrival_at: responseDateTime().nullable(),
  started_at: responseDateTime().nullable(),
  completed_at: responseDateTime().nullable(),
  cancellation_reason: z.string().nullable(),
  closure_reason: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Por que a rota foi encerrada com paradas em aberto (Encerrar com pendências, plano de 02/11/2026 K11); null numa rota que terminou sozinha.",
    ),
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
  released_at: responseDateTime()
    .nullable()
    .describe(
      "Quando a rota foi liberada ao motorista; nulo enquanto rascunho.",
    ),
  created_at: responseDateTime(),
  updated_at: responseDateTime(),
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
  recordedAt: responseDateTime(),
  // Plan of 02/11/2026 (E5): the stop card's "Fora do raio" flag, with the
  // names the delivery detail uses.
  geofence_outcome: z
    .enum(["INSIDE", "OUTSIDE", "NOT_EVALUATED"])
    .nullable()
    .describe(
      'Geocerca da chegada ou do comprovante (Configurações da empresa): INSIDE, OUTSIDE (o selo "Fora do raio" da parada) ou NOT_EVALUATED. Null num ponto de antes da geocerca.',
    ),
  distance_m: z
    .number()
    .nullable()
    .describe(
      "Distância em metros entre a posição e o ponto do endereço; null quando não avaliada.",
    ),
  accuracy_m: z
    .number()
    .nullable()
    .describe(
      "Precisão da posição em metros, como o aparelho informou; null quando o aparelho não a mandou.",
    ),
});

/** A stop recorded outside the radius (E5), for its card's flag. */
const stopGeofenceEntity = z.object({
  deliveryId: z.string(),
  type: z
    .enum(["ARRIVAL", "PROOF", "OCCURRENCE"])
    .describe(
      "O apontamento fora do raio: chegada, comprovante ou ocorrência.",
    ),
  geofence_outcome: z.literal("OUTSIDE"),
  distance_m: z
    .number()
    .nullable()
    .describe("Distância em metros até o ponto do endereço."),
  accuracy_m: z
    .number()
    .nullable()
    .describe(
      "Precisão da posição em metros; null quando o aparelho não a mandou.",
    ),
  recordedAt: responseDateTime().describe(
    "Quando aconteceu (relógio do aparelho corrigido).",
  ),
});

/** A route checklist as the detail lists it (F3; the driver payload's shape). */
const routeChecklistEntity = z.object({
  id: z.string(),
  checklist_date: responseDateTime(),
  overall_condition: z
    .string()
    .describe("approved, approved_with_restrictions ou rejected."),
});

/** A refuelling made on the route (F3), amounts as numbers. */
const routeFuelEntity = z.object({
  id: z.string(),
  refueling_date: responseDateTime(),
  liters_amount: z.number(),
  price_per_liter: z.number(),
  total_amount: z.number(),
  current_mileage: z.number(),
  vehicleId: z.string(),
  driverId: z.string(),
  odometer_ai_status: z
    .string()
    .describe("Situação da leitura do hodômetro pela IA."),
  // 05/11/2026 (20261105130000), as the fuel list.
  alerts: z
    .array(z.enum(FUEL_ALERTS))
    .describe(
      "Alertas do abastecimento; vazio quando nada. RECENT_REFUEL: outro abastecimento do mesmo veículo a menos de 30 minutos deste.",
    ),
  recent_refuel_reason: z
    .string()
    .nullable()
    .describe(
      "O motivo que o motorista informou ao confirmar; null sem confirmação ou sem o alerta.",
    ),
  recent_refuel_previous_at: responseDateTime()
    .nullable()
    .describe(
      "A data do outro abastecimento (RECENT_REFUEL); null sem o alerta.",
    ),
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
  scheduled_date: responseDateTime()
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
  closeRouteWithPending: closeRouteWithPendingSchema,

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
          statusCounts: countsPer(routeStatusEnum).describe(
            "Rotas por status com a busca e os demais filtros, sem o de status (os cartões). Nunca da página; os cinco status vêm sempre, inclusive zerados.",
          ),
          timeZone: z
            .string()
            .describe(
              "Fuso da empresa (IANA, ex.: America/Sao_Paulo), para mostrar Previsto, Saída e Conclusão no relógio da empresa, como o detalhe da rota (meta.timeZone do get-route).",
            ),
          period: z
            .object({
              from: z
                .string()
                .describe(
                  "Primeiro dia do período (AAAA-MM-DD), no fuso da empresa.",
                ),
              to: z
                .string()
                .describe("Último dia do período (AAAA-MM-DD), incluído."),
              applied: z
                .boolean()
                .describe(
                  "false quando a busca era exatamente o número ou o ID inteiro de uma rota: o período foi ignorado e as linhas podem ser de outros dias.",
                ),
            })
            .nullable()
            .describe(
              "Os dias que a página e as contagens cobrem, pelo dia da rota (quando o período inclui hoje, com as rotas ainda em andamento e as de dias anteriores que não saíram); null sem `period` (todas as datas).",
            ),
        },
        ["status", "driverId", "vehicleId"],
      ),
    }),
  }),

  /**
   * One line of the stream, after the envelope (plan of 02/11/2026, K14):
   * the route without its stops' deliveries — the board reads progress and
   * blockers from `stopCounts`.
   */
  routeListRow: routeEntity.omit({ stops: true }).extend({
    stopCounts: countsPer(routeStopStatusEnum).describe(
      "Paradas da rota por status (PENDING, ARRIVED, COMPLETED, FAILED, CANCELLED; os cinco sempre, inclusive zerados). É daqui que a lista tira o progresso e os bloqueios; as paradas com as entregas ficam no detalhe (get-route).",
    ),
    stops: z
      .array(z.object({ id: z.string(), status: routeStopStatusEnum }))
      .describe(
        "OBSOLETO, só nesta versão: as paradas com id e status, sem entrega, para a versão do painel ainda em uso. Use `stopCounts`; o campo sai da lista na próxima versão da API.",
      ),
  }),
  routeDetail: z.object({
    data: routeEntity.extend({
      driverPosition: driverPositionEntity,
      visitedPoints: z
        .array(visitedPointEntity)
        .describe(
          "GPS capturado na chegada e no comprovante das paradas desta rota, para o mapa. Com mais de 400 registros, ficam os 400 mais recentes, em ordem cronológica.",
        ),
      stopGeofence: z
        .array(stopGeofenceEntity)
        .optional()
        .describe(
          'As paradas com apontamento fora do raio nesta rota (plano de 02/11/2026, E5), uma linha por entrega: o registro OUTSIDE mais recente entre a chegada, o comprovante e as ocorrências. É o selo "Fora do raio" do card da parada — a ocorrência, que sempre passa sinalizada, não é ponto do mapa e não vem em `visitedPoints`. Vazio para o aplicativo do motorista.',
        ),
      checklists: z
        .object({
          route_start: routeChecklistEntity.nullable(),
          route_end: routeChecklistEntity.nullable(),
        })
        .nullable()
        .optional()
        .describe(
          "Checklists do veículo feitos para esta rota (plano de 02/11/2026, F3): o mais recente da saída (ROUTE_START) e o da chegada (ROUTE_END); null no momento sem checklist. O objeto inteiro é null quando quem lê não pode ver checklists (empresa sem Gestão de Frotas ligada, ou perfil sem `vehicle_checklist_manage` leitura).",
        ),
      fuels: z
        .array(routeFuelEntity)
        .nullable()
        .optional()
        .describe(
          "Abastecimentos feitos nesta rota, do mais antigo ao mais recente (F3). null quando quem lê não pode ver abastecimentos (empresa sem Gestão de Frotas ligada, ou perfil sem `fuel_manage` leitura).",
        ),
    }),
    meta: z.object({
      progress: z.object({
        done: z
          .number()
          .describe("Paradas já resolvidas, de qualquer desfecho."),
        total: z.number(),
      }),
      timeZone: z
        .string()
        .optional()
        .describe(
          "O fuso da empresa (IANA), ex.: America/Sao_Paulo: os horários da rota são mostrados nele, com a nota, como na torre (plano de 02/11/2026, G8).",
        ),
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
    data: z.object({
      id: z.string(),
      started_at: responseDateTime().nullable(),
    }),
  }),
  routeCancelled: z.object({ message: z.string().default("Rota cancelada.") }),
  routeClosedWithPending: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      status: routeStatusEnum,
      completed_at: responseDateTime().nullable(),
      closure_reason: z.string().nullable(),
      cancelledStops: z
        .number()
        .describe(
          "Paradas em aberto que foram canceladas; as entregas delas voltaram a Pendente.",
        ),
      planVersion: z.number(),
      unchanged: z
        .boolean()
        .describe(
          "true quando a rota já estava encerrada com pendências (duplo clique, reenvio): nada foi gravado nem avisado de novo.",
        ),
    }),
  }),

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
      geo_updated_at: responseDateTime().nullable(),
      routeId: z
        .string()
        .nullable()
        .describe(
          "A rota PLANNED/RELEASED que tem a entrega como parada aberta, cujo plano subiu de versão; nulo quando nenhuma. Também nulo numa rota IN_PROGRESS: a versão dela não sobe, e o app do motorista só é avisado em silêncio (route-stop.located) para ler o ponto novo.",
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
        .optional()
        .describe(
          "Entregas sem rota com a busca e TODOS os filtros. Só na primeira página (sem `cursor`).",
        ),
      page: z.number(),
      pageSize: z.number(),
      nextCursor: z
        .string()
        .nullable()
        .describe(
          "Envie como `cursor` para a página seguinte (G9); nulo no fim da lista.",
        ),
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
        .optional()
        .describe(
          "Opções de cada filtro com a busca e os DEMAIS filtros (regra disjuntiva). Cidades e embarcadores: no máximo 50. Só na primeira página (sem `cursor`).",
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
        "ROUTE_STATUS_CONFLICT, DELIVERY_ALREADY_ON_ROUTE, ROUTE_REORDER_MISMATCH ou ROUTE_PLAN_STALE (a versão do plano mudou desde a leitura) significam a mesma ação do usuário: atualizar a tela. ROUTE_DRIVER_BUSY (saída) diz que o motorista já está com outra rota em andamento; ROUTE_VEHICLE_BUSY (saída), que o veículo ainda está em outra rota em andamento (a mensagem nomeia a placa e a rota); DELIVERY_ON_STARTED_ROUTE, que a entrega está numa rota que já saiu. ROUTE_CODE_TAKEN (criação simultânea na mesma empresa, raro): basta reenviar. ROUTE_BRANCH_REQUIRED (liberar, ou trocar o veículo ou o motorista de uma rota liberada, com o checklist da rota exigido e sem filial ativa para registrá-lo): mostre a mensagem, que diz qual veículo ou motorista completar, ou qual filial está inativa. Nada foi gravado.",
      ),
    message: z.string(),
  }),
  internalServerError: z.object({
    code: z.string().default("INTERNAL_ERROR"),
    message: z.string().default("Internal server error"),
  }),
};

export { routeSchemas, routeResponses };
