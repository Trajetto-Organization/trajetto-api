import { z } from "zod";

import { errorResponse } from "./common-responses";

import { DRIVER_PAUSE_KINDS } from "@/modules/driver-pause/dtos/driver-pause-dto";
import { PAUSE_FLAG_CODES } from "@/modules/driver-pause/rules/pause-report-rules";

/**
 * What the pause routes answer. The success shapes are real schemas (the
 * serializer applies them), the error ones document the handler's body with
 * the codes each status carries.
 */

const isoDateTime = z.string().describe("Instante ISO 8601 (UTC).");

const pauseView = z.object({
  id: z.string(),
  kind: z.enum(DRIVER_PAUSE_KINDS).describe("MEAL (refeição), REST (descanso) ou OTHER."),
  started_at: isoDateTime.describe("Início, pelo relógio do aparelho corrigido (occurred_at)."),
  ended_at: isoDateTime.nullable().describe("Fim; nulo enquanto a pausa está aberta."),
  duration_minutes: z
    .number()
    .int()
    .nullable()
    .describe("Minutos inteiros (arredondados para baixo); nulo enquanto aberta."),
  note: z.string().nullable(),
  routeId: z
    .string()
    .nullable()
    .describe(
      "A rota da jornada no instante do início (liberada ou em andamento; decisão 14.4). Pausas anteriores à regra podem não ter.",
    ),
  start_submission_id: z.string(),
  end_submission_id: z.string().nullable(),
  start_latitude: z.number().nullable(),
  start_longitude: z.number().nullable(),
  end_latitude: z.number().nullable(),
  end_longitude: z.number().nullable(),
  occurrence_type: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .describe("O tipo de pausa escolhido (decisão 14.4); `kind` é a natureza legal dele."),
});

const pauseWrite = z.object({
  pause: pauseView,
  replayed: z
    .boolean()
    .describe("true quando a mesma chave já tinha feito este gesto (reenvio da fila): nada novo foi gravado."),
});

const currentPause = z.object({
  timeZone: z.string().describe("O fuso da empresa."),
  day: z.string().describe("O dia de hoje da empresa (AAAA-MM-DD)."),
  open: pauseView
    .nullable()
    .describe("A pausa aberta do motorista, de qualquer dia; nula quando não há. É por ela que o app sabe que está em pausa."),
  today: z
    .array(pauseView)
    .describe("As pausas iniciadas hoje no fuso da empresa, da mais antiga para a mais nova."),
  pause_allowed: z
    .boolean()
    .describe(
      "Decisão 14.4: verdadeiro quando o motorista tem agora uma rota liberada ou em andamento do dia — só então o app mostra \"Iniciar pausa\". Encerrar uma pausa aberta é sempre possível.",
    ),
  journey_route_id: z
    .string()
    .nullable()
    .describe("A rota da jornada agora; nula fora de jornada."),
});

const reportPause = z.object({
  id: z.string(),
  kind: z.enum(DRIVER_PAUSE_KINDS),
  occurrence_type_name: z
    .string()
    .nullable()
    .describe("O nome do tipo de pausa escolhido (decisão 14.4); `kind` é a natureza legal que os alertas leem."),
  status: z
    .enum(["ENDED", "ONGOING", "NOT_ENDED", "TOO_LONG"])
    .describe(
      "ENDED: encerrada. ONGOING: aberta há menos de 12 h (em andamento). NOT_ENDED: aberta há mais de 12 h — esquecida; fica fora dos cálculos. TOO_LONG: encerrada só depois de mais de 12 h — esquecida aberta; a duração registrada aparece, mas fica fora dos cálculos.",
    ),
  started_at: isoDateTime,
  ended_at: isoDateTime.nullable(),
  duration_minutes: z
    .number()
    .int()
    .nullable()
    .describe(
      "Encerrada: a duração. Em andamento: até agora. TOO_LONG: a duração registrada (fora dos cálculos). Não encerrada: nulo.",
    ),
  note: z.string().nullable(),
  routeId: z.string().nullable(),
});

const flagCode = z.enum(PAUSE_FLAG_CODES);

const driverDay = z.object({
  id: z.string().describe("`<driverId>:<dia>`, estável entre páginas."),
  day: z.string().describe("O dia da jornada (AAAA-MM-DD), no fuso da empresa: o dia em que ela começou."),
  driverId: z.string(),
  driverName: z.string(),
  inProgress: z
    .boolean()
    .describe("Rota em andamento ou pausa aberta: a jornada ainda não terminou, e os alertas de refeição esperam o fim."),
  workday: z.object({
    start: isoDateTime.describe("Primeiro início de rota ou de pausa."),
    end: isoDateTime.describe(
      "Último fim de rota ou de pausa (de uma pausa esquecida conta só o início); em andamento, agora.",
    ),
    minutes: z.number().int(),
  }),
  pauses: z.array(reportPause),
  totals: z.object({
    pauseMinutes: z
      .number()
      .int()
      .describe("Tempo total em pausa (sobreposições contadas uma vez; pausas esquecidas fora)."),
    mealMinutes: z.number().int().describe("Tempo em refeição (sobreposições contadas uma vez)."),
    longestMealMinutes: z.number().int().describe("O maior intervalo contínuo de refeição."),
    restMinutes: z.number().int(),
    otherMinutes: z.number().int(),
    drivingMinutes: z
      .number()
      .int()
      .describe("Direção ESTIMADA: tempo de rota em andamento menos as pausas (inclui o tempo parado nos clientes)."),
    longestDrivingWithoutRestMinutes: z
      .number()
      .int()
      .describe("O maior trecho de direção estimada antes de somar 30 min de descanso."),
  }),
  previousWorkdayEnd: isoDateTime
    .nullable()
    .describe("Fim da jornada anterior do motorista, quando há uma nos dois dias antes."),
  restBeforeMinutes: z
    .number()
    .int()
    .nullable()
    .describe("Descanso desde a jornada anterior (interjornada)."),
  flags: z
    .array(z.object({ code: flagCode, message: z.string().describe("A explicação, em português.") }))
    .describe(
      "Alertas da Lei 13.103/2015 — só sinalizam, nada é bloqueado. MEAL_MISSING: jornada acima de 6 h sem pausa de refeição. MEAL_SHORT: a maior refeição teve menos de 1 h. DRIVING_REST_SHORT: mais de 6 h de direção estimada sem somar 30 min de descanso. INTERJORNADA_SHORT: menos de 11 h desde o fim da jornada anterior. PAUSE_NOT_ENDED: pausa aberta há mais de 12 h. PAUSE_TOO_LONG: pausa encerrada só depois de mais de 12 h (esquecida aberta); a duração fica fora dos cálculos.",
    ),
});

const facetCount = z.object({
  value: z.string(),
  label: z.string().optional().describe("Nome do motorista (só na faceta de motoristas)."),
  count: z.number().int(),
});

const pauseReport = z.object({
  timeZone: z.string().describe("O fuso da empresa em que os dias são contados."),
  from: z.string().describe("Primeiro dia do período (AAAA-MM-DD)."),
  to: z.string().describe("Último dia do período (AAAA-MM-DD)."),
  rules: z
    .object({
      mealMinMinutes: z.number().int(),
      mealRequiredAboveWorkdayMinutes: z.number().int(),
      drivingBlockMinutes: z.number().int(),
      drivingRestMinutes: z.number().int(),
      interjornadaMinutes: z.number().int(),
      forgottenPauseMinutes: z.number().int(),
    })
    .describe("Os limites que os alertas usam, em minutos."),
  total: z.number().int().describe("Dias de jornada com todos os filtros (paginador)."),
  page: z.number().int(),
  pageSize: z.number().int(),
  searchMeta: z.object({
    days: z.number().int().describe("Dias de jornada com todos os filtros."),
    drivers: z.number().int().describe("Motoristas distintos nesses dias."),
    pauses: z.number().int().describe("Pausas nesses dias."),
    daysWithAlerts: z
      .number()
      .int()
      .describe("Dias com ao menos um alerta, com o filtro de motorista e sem o de alerta."),
    facets: z.object({
      driverId: z
        .array(facetCount)
        .describe("Motoristas com jornada no período, contados com o filtro de alerta (nunca o próprio)."),
      flag: z
        .array(facetCount)
        .describe("Cada alerta, contado com o filtro de motorista (nunca o próprio)."),
    }),
  }),
  data: z
    .array(driverDay)
    .describe("Um dia de jornada por linha: o dia mais recente primeiro, depois o nome do motorista."),
});

const withCodes = (description: string) =>
  errorResponse.extend({ code: z.string().optional().describe(description) });

const driverPauseResponses = {
  pauseWrite,
  currentPause,
  pauseReport,

  startBadRequest: withCodes(
    "VALIDATION_ERROR: corpo inválido (a lista em `issues`), inclusive sem `occurrence_type_id` nem `kind`. OCCURRENCE_TYPE_WRONG_CATEGORY: `occurrence_type_id` é de um tipo que não é de pausa.",
  ),
  typeNotFound: withCodes(
    "OCCURRENCE_TYPE_NOT_FOUND: `occurrence_type_id` não é um tipo desta empresa (a mesma resposta para um de outra empresa).",
  ),
  endNotFound: withCodes(
    "PAUSE_NOT_FOUND: nenhuma pausa com esse `start_submission_id` nesta empresa, e o fim não trouxe `start` para criá-la. OCCURRENCE_TYPE_NOT_FOUND: `start.occurrence_type_id` não é um tipo desta empresa.",
  ),
  startConflict: withCodes(
    "PAUSE_ALREADY_OPEN: o motorista já tem outra pausa aberta (chave diferente); leia GET /driver-pause/current para saber qual. SUBMISSION_OWNER_MISMATCH: a chave já foi usada por outro motorista; gere outra. PAUSE_TOO_OLD: início novo tocado há mais de 7 dias; nada foi gravado e o item sai da fila. PAUSE_REQUIRES_ROUTE: no instante do toque o motorista não tinha rota liberada ou em andamento do dia (decisão 14.4); nada foi gravado.",
  ),
  endConflict: withCodes(
    "PAUSE_ALREADY_ENDED: a pausa já foi encerrada por outro fim (chave diferente); nada muda. PAUSE_SUBMISSION_REUSED: esta chave de fim já encerrou outra pausa; gere outra. SUBMISSION_OWNER_MISMATCH: a pausa (ou a chave) é de outro motorista. PAUSE_TOO_OLD: a pausa teria de ser criada a partir de `start` com um toque de mais de 7 dias; nada foi gravado e o item sai da fila. PAUSE_REQUIRES_ROUTE: a pausa teria de ser criada a partir de `start`, e no toque do início não havia rota liberada ou em andamento do dia; nada foi gravado.",
  ),
  reportBadRequest: withCodes(
    "VALIDATION_ERROR: filtro ou data mal formados. PAUSE_REPORT_RANGE_INVALID: período invertido, maior que 31 dias ou com data fora de 2000 a 2099.",
  ),
  notFound: withCodes("TENANT_NOT_FOUND: a empresa não existe."),
  internalServerError: z.object({
    code: z.string().default("INTERNAL_ERROR"),
    message: z.string().default("Internal server error"),
  }),
};

export { driverPauseResponses };
