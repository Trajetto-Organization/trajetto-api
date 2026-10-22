import { z } from "zod";

import {
  controlTowerSchema,
  driverMonitoringSchema,
  driverTrailParamSchema,
  driverTrailQuerySchema,
  recordDriverPositionsSchema,
  routeMonitoringSchema,
} from "@/schemas/driver-position-schema";

/**
 * The operation's live surfaces: the phone's positions, the control tower,
 * one driver's trail and the monitoring board by route.
 *
 * Apart from the route CRUD's documentation because these are read by other
 * screens with other rules — the company's business day, not the request's
 * — and a shape change here must not ride along with a route form's.
 */

const isoDateTime = z.string().describe("Instante ISO 8601 (UTC).");

const towerPosition = z.object({
  driverId: z.string(),
  driverName: z.string().nullable(),

  routeId: z
    .string()
    .describe(
      "A rota que explica o ponto: a em andamento ou a encerrada há menos de 2 h.",
    ),
  routeCode: z.number(),
  routeStatus: z.enum(["IN_PROGRESS", "COMPLETED", "CANCELLED"]),

  vehiclePlate: z.string().nullable(),

  latitude: z.number(),
  longitude: z.number(),

  speed: z.number().nullable(),
  heading: z.number().nullable(),
  battery: z.number().nullable(),

  recordedAt: isoDateTime,

  fresh: z
    .boolean()
    .describe("Ponto de rota em andamento com menos de 10 min."),
  state: z
    .enum(["moving", "silent", "ended"])
    .describe(
      'moving: rota em andamento e telefone reportando; silent: rota em andamento sem ponto há mais de 10 min (só estes contam em "sem reportar"); ended: rota concluída ou cancelada há menos de 2 h — depois disso o ponto sai do mapa.',
    ),
  endedAt: isoDateTime.nullable(),
  pausedSince: isoDateTime
    .nullable()
    .describe(
      "Início da pausa aberta do motorista (refeição, descanso), só para rota em andamento; null quando não está em pausa. O mapa desenha o veículo como pausado, não como parado.",
    ),
});

const towerActiveRoute = z.object({
  routeId: z.string(),
  routeCode: z.number(),
  routeName: z.string().nullable(),
  destination: z.string().nullable(),

  driverId: z.string(),
  driverName: z.string().nullable(),
  vehiclePlate: z.string().nullable(),

  startedAt: isoDateTime.nullable(),
  lastSignalAt: isoDateTime
    .nullable()
    .describe(
      "Último ponto do telefone, mesmo fora da janela de 12 h do mapa; nulo = o telefone nunca reportou.",
    ),

  progress: z.object({
    resolved: z.number().describe("Paradas entregues ou com insucesso."),
    total: z.number().describe("Paradas da rota, sem as canceladas."),
  }),
});

const towerEvent = z.object({
  id: z.string(),
  source: z.enum(["delivery_event", "occurrence", "route"]),
  type: z
    .string()
    .describe(
      "ARRIVAL, PROOF, STATUS_CHANGE, NOTE, ON_THE_WAY ou OCCURRENCE (documento); ROUTE_STARTED, ROUTE_COMPLETED ou ROUTE_CANCELLED (rota).",
    ),
  actor: z.string(),

  deliveryId: z.string().nullable(),
  recipientName: z.string().nullable(),

  routeId: z.string().nullable(),
  routeCode: z.number().nullable(),

  driverName: z.string().nullable(),

  detail: z
    .string()
    .nullable()
    .describe(
      "O tipo da ocorrência, ou o status para o qual uma mudança manual levou.",
    ),
  failure: z
    .boolean()
    .describe("Ocorrência impeditiva aplicada ou mudança para Insucesso."),

  occurredAt: isoDateTime,
});

const routeProgress = z.object({
  total: z.number(),
  delivered: z.number(),
  failed: z.number(),
  pending: z.number(),
  cancelled: z.number(),
  arrived: z.number(),
  onTheWay: z.number(),
  completion: z
    .number()
    .nullable()
    .describe(
      "(entregues + insucessos) / (total − canceladas), em %; nulo sem paradas.",
    ),
  deliveredRate: z
    .number()
    .nullable()
    .describe("entregues / (total − canceladas), em %."),
});

const monitoredStop = z.object({
  id: z.string(),
  sequence: z.number(),
  status: z.enum(["PENDING", "ARRIVED", "COMPLETED", "FAILED", "CANCELLED"]),
  deliveryId: z.string(),
  recipientName: z.string(),
  city: z.string(),
  onTheWayAt: isoDateTime.nullable(),
  arrivedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
});

const monitoredRoute = z.object({
  id: z.string(),
  code: z.number(),
  name: z.string().nullable(),
  destination: z.string().nullable(),
  status: z.enum([
    "PLANNED",
    "RELEASED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
  ]),

  scheduledDate: z.string().describe("Data sem hora (AAAA-MM-DD)."),

  plannedDepartureAt: isoDateTime.nullable(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),

  driver: z.object({ id: z.string(), name: z.string().nullable() }),
  vehiclePlate: z.string().nullable(),

  progress: routeProgress,
  stops: z.array(monitoredStop),
});

const driverDayRow = z.object({
  driverId: z.string(),
  driverName: z.string(),
  cnh: z.string(),
  designated: z
    .number()
    .describe(
      "Pendentes nas rotas do dia (ou numa rota ainda em andamento) — não as de outros dias.",
    ),
  inRoute: z.number().describe("Na rua agora (IN_TRANSIT)."),
  deliveredToday: z.number().describe("Entregues no dia, por delivered_at."),
  failedToday: z
    .number()
    .describe("Insucessos no dia, pelo fato que causou a falha."),
});

/**
 * Every refusal carries a machine-readable `code` alongside the message (and
 * the header `x-error-code`): PERMISSION_DENIED, MODULE_NOT_ENABLED,
 * TENANT_INACTIVE, DRIVER_CANNOT_VIEW_PANELS, BUSINESS_NOT_IDENTIFIED,
 * DRIVER_NOT_FOUND, INVALID_DAY, VALIDATION_ERROR, RATE_LIMITED.
 */
const towerError = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.string()).optional(),
});

const controlTowerSchemas = {
  recordPositions: recordDriverPositionsSchema,
  controlTower: controlTowerSchema,
  driverTrailParams: driverTrailParamSchema,
  driverTrailQuery: driverTrailQuerySchema,
  routeMonitoring: routeMonitoringSchema,
  driverMonitoring: driverMonitoringSchema,
};

const controlTowerResponses = {
  positionsRecorded: z.object({
    message: z.string(),
    data: z.object({
      stored: z.number(),
      rejected: z.number(),

      tracking: z
        .boolean()
        .describe(
          "Falso quando nenhuma rota do motorista está em andamento. O app PARA de rastrear ao ver isto — continuar seria gastar a bateria de alguém num mapa que ninguém está olhando.",
        ),
    }),
  }),

  controlTower: z.object({
    data: z.object({
      day: z
        .string()
        .describe(
          "O dia da empresa ao qual os números se referem (AAAA-MM-DD).",
        ),
      timeZone: z.string().describe('O fuso da empresa usado para "hoje".'),

      positions: z.array(towerPosition),
      activeRoutes: z
        .array(towerActiveRoute)
        .describe(
          "Rotas em andamento, com ou sem posição — a que não tem ponto no mapa aparece aqui.",
        ),

      funnel: z.array(
        z.object({
          status: z.enum([
            "PENDING",
            "IN_TRANSIT",
            "DELIVERED",
            "FAILED",
            "CANCELLED",
          ]),
          label: z.string(),
          total: z.number(),
        }),
      ),

      progress: z.object({
        finished: z
          .number()
          .describe("Entregues, insucessos e canceladas resolvidos no dia."),
        total: z.number(),
        rate: z.number().nullable(),
      }),

      punctuality: z.object({
        onTime: z.number(),
        late: z
          .number()
          .describe("Saíram depois do horário planejado + 15 min."),
        notDeparted: z
          .number()
          .describe(
            "O horário planejado + 15 min já passou e a rota não saiu: entra na taxa como atraso.",
          ),
        waiting: z
          .number()
          .describe("O horário planejado ainda não chegou: fora da taxa."),
        notPlanned: z.number(),
        rate: z.number().nullable(),
      }),

      events: z.array(towerEvent),
    }),
  }),

  driverTrail: z.object({
    data: z.object({
      driverId: z.string(),
      day: z
        .string()
        .describe("O dia do trajeto no fuso da empresa (AAAA-MM-DD)."),

      recorded: z
        .number()
        .describe(
          "Quantos pontos existem, antes do afinamento. A tela mostra os dois — quem visse só o desenhado concluiria que o telefone parou de reportar.",
        ),

      points: z.array(
        z.object({
          latitude: z.number(),
          longitude: z.number(),
          speed: z.number().nullable(),
          recordedAt: isoDateTime,
        }),
      ),
    }),
  }),

  routeMonitoring: z.object({
    data: z.object({
      day: z.string(),
      timeZone: z
        .string()
        .describe("O fuso da empresa: as horas do quadro são mostradas nele."),
      routes: z.array(monitoredRoute),
      meta: z.object({
        total: z.number(),
        page: z.number(),
        pageSize: z.number(),
      }),
    }),
  }),

  driverMonitoring: z.object({
    data: z.object({
      day: z
        .string()
        .describe(
          "O dia da empresa ao qual os números se referem (AAAA-MM-DD).",
        ),
      timeZone: z.string().describe("O fuso da empresa usado para o dia."),
      drivers: z
        .array(driverDayRow)
        .describe(
          "Um motorista por linha, quem está na rua primeiro; empate em ordem alfabética.",
        ),
    }),
  }),

  error: towerError,

  /** A 404 naming its codes; the tower reads the session user first. */
  notFound: (codes: string) =>
    towerError.extend({ code: z.string().describe(codes) }).describe(codes),

  internalServerError: z.object({
    code: z.string().default("INTERNAL_ERROR"),
    message: z.string().default("Internal server error"),
  }),
};

export { controlTowerResponses, controlTowerSchemas };
