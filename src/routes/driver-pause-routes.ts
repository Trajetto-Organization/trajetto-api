import { FastifyInstance } from "fastify";

import "@/modules/driver-pause/container";

import { StartDriverPauseController } from "@/modules/driver-pause/usecases/start-driver-pause/start-driver-pause-controller";
import { EndDriverPauseController } from "@/modules/driver-pause/usecases/end-driver-pause/end-driver-pause-controller";
import { CurrentDriverPauseController } from "@/modules/driver-pause/usecases/current-driver-pause/current-driver-pause-controller";
import { DriverPauseReportController } from "@/modules/driver-pause/usecases/driver-pause-report/driver-pause-report-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import { clientSentAtHeaders } from "@/shared/delivery/occurred-at";

import {
  businessParam,
  endPauseBody,
  reportQuery,
  startPauseBody,
} from "@/modules/driver-pause/schemas/driver-pause-schemas";
import { driverPauseResponses as responses } from "./documentation/driver-pause-documentation";
import { errorResponse } from "./documentation/common-responses";

const startController = new StartDriverPauseController();
const endController = new EndDriverPauseController();
const currentController = new CurrentDriverPauseController();
const reportController = new DriverPauseReportController();

/**
 * Pauses belong to the deliveries operation (the app's driver loop), so they
 * sit behind the same module switch. The driver writes with the app's
 * `delivery_manage:write`; the use cases refuse anybody without a driver.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

/**
 * The office report: whoever follows deliveries, the same key as the one
 * screen that shows it (decision 4.2: the menu and the API answer alike). A
 * driver token is refused: the report is every driver's day.
 */
const reportReaders = verifyPermission("delivery_manage", "read", { allowDriver: false });

/**
 * The report is built in memory from up to 34 days of a company's routes and
 * pauses: cheap per request once linear, but not free, so a tighter ceiling
 * than the global 300/min keeps a loop on it from stalling the replica.
 */
const reportConfig = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/** The driver surface: the app resends from its outbox after dead networks. */
const driverWriteConfig = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
  // Read by the controllers to date a gesture queued offline (MOB-08).
  openapi: { headers: clientSentAtHeaders },
};

async function driverPauseRoutes(app: FastifyInstance) {
  app.post(
    "/start/:businessId",
    {
      config: driverWriteConfig,
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver-pause"],
        summary: "O motorista inicia uma pausa",
        description:
          "Refeição (MEAL), descanso (REST) ou outra (OTHER), pelo aplicativo do motorista, inclusive sem sinal (decisão 6.1). Só o próprio motorista registra: outro usuário recebe 403 PERMISSION_DENIED. Idempotente por `start_submission_id`: o reenvio da mesma chave responde 200 com a mesma pausa (`replayed: true`), aberta ou já encerrada, sem gravar nada; a primeira vez responde 201. No máximo uma pausa aberta por motorista, garantido pelo banco mesmo sob concorrência: outro início com chave diferente responde 409 PAUSE_ALREADY_OPEN. Uma chave já usada por outro motorista responde 409 SUBMISSION_OWNER_MISMATCH. `occurred_at` (opcional) é o instante do toque, corrigido pelo header `X-Client-Sent-At`; nunca no futuro; ausente ou ilegível, vale a hora do recebimento. Um início NOVO tocado há mais de 7 dias (fora do horizonte offline) responde 409 PAUSE_TOO_OLD e nada é gravado: datá-lo pela chegada abriria agora uma pausa que o motorista não começou; o reenvio de um início que já entrou continua respondendo 200. Decisão 14.4: o corpo traz `occurrence_type_id`, o tipo da categoria Pausa escolhido (a natureza gravada em `kind` é a do tipo; tipo desativado é aceito, porque a pausa aconteceu); o aplicativo instalado manda só `kind`, e a pausa vai para o tipo padrão dessa natureza. Tipo de outra empresa → 404 OCCURRENCE_TYPE_NOT_FOUND; tipo de outra categoria → 400 OCCURRENCE_TYPE_WRONG_CATEGORY. Pausa só existe dentro de uma jornada: sem rota do motorista liberada ou em andamento do dia (no fuso da empresa) no instante do toque, 409 PAUSE_REQUIRES_ROUTE e nada é gravado. A pausa guarda a rota dessa jornada.",
        params: businessParam,
        body: startPauseBody,
        response: {
          200: responses.pauseWrite,
          201: responses.pauseWrite,
          400: responses.startBadRequest,
          401: errorResponse,
          403: errorResponse,
          404: responses.typeNotFound,
          409: responses.startConflict,
          429: errorResponse,
          500: responses.internalServerError,
        },
      },
    },
    startController.handle,
  );

  app.post(
    "/end/:businessId",
    {
      config: driverWriteConfig,
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver-pause"],
        summary: "O motorista encerra uma pausa",
        description:
          "Aponta a pausa pela chave do início (`start_submission_id`), porque sem sinal o aplicativo ainda não conhece o id dela. Idempotente por `end_submission_id`: o reenvio responde 200 com a pausa já encerrada (`replayed: true`). Seguro em qualquer ordem de entrega da fila: se o fim chega antes do início, a pausa é criada já encerrada a partir de `start` (o início repetido), e o início, quando chegar, responde 200 com ela; sem `start`, 404 PAUSE_NOT_FOUND. Dois fins concorrentes encerram uma vez só: o outro recebe 409 PAUSE_ALREADY_ENDED. Uma chave de fim que já encerrou outra pausa: 409 PAUSE_SUBMISSION_REUSED. Pausa ou chave de outro motorista: 409 SUBMISSION_OWNER_MISMATCH. `occurred_at` segue a mesma correção do início (`X-Client-Sent-At`, também para o `occurred_at` de `start`); o fim nunca fica antes do início. Criar a pausa a partir de `start` quando o início ou o fim foram tocados há mais de 7 dias responde 409 PAUSE_TOO_OLD e nada é gravado; já encerrar uma pausa que existe nunca é recusado por isso (o fim vale a hora do recebimento, e o relatório sinaliza a pausa encerrada depois de 12 h). Encerrar uma pausa que existe nunca é recusado por falta de rota; um fim que CRIA a pausa (o início ainda não chegou) segue a regra de jornada no instante do início (409 PAUSE_REQUIRES_ROUTE). `start.occurrence_type_id` segue as regras do início. Só o próprio motorista registra.",
        params: businessParam,
        body: endPauseBody,
        response: {
          200: responses.pauseWrite,
          400: responses.startBadRequest,
          401: errorResponse,
          403: errorResponse,
          404: responses.endNotFound,
          409: responses.endConflict,
          429: errorResponse,
          500: responses.internalServerError,
        },
      },
    },
    endController.handle,
  );

  app.get(
    "/current/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver-pause"],
        summary: "A pausa aberta do motorista e as pausas de hoje",
        description:
          "O que o aplicativo lê para saber se o motorista está em pausa (depois de reinstalar, trocar de aparelho ou entrar de novo): `open` é a pausa aberta, de qualquer dia, e traz a `start_submission_id` que o fim precisa nomear; `today` são as pausas iniciadas hoje, no fuso da empresa. `pause_allowed` diz se uma pausa pode começar agora (rota liberada ou em andamento do dia; decisão 14.4) e `journey_route_id` é essa rota. Só o próprio motorista: outro usuário recebe 403 PERMISSION_DENIED.",
        params: businessParam,
        response: {
          200: responses.currentPause,
          404: responses.notFound,
          500: responses.internalServerError,
        },
      },
    },
    currentController.handle,
  );

  app.get(
    "/report/:businessId",
    {
      config: reportConfig,
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, reportReaders],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["driver-pause"],
        summary: "Relatório de pausas por motorista e dia",
        description:
          "Um dia de jornada por linha, no fuso da empresa: as pausas, o início e o fim da jornada, o tempo em pausa, a direção ESTIMADA e os alertas da Lei 13.103/2015 — só sinalizam, nada é bloqueado. Jornada: das rotas que saíram no dia (do início à conclusão ou ao cancelamento; em andamento, até agora) e das pausas que vão com elas; uma pausa dentro de uma rota pertence à jornada dessa rota, então uma rota que atravessa a meia-noite é uma jornada só. Uma pausa fora de rota vai com a rota mais próxima (a que terminou antes ou a que começa depois) quando a distância é menor que 11 h — um descanso logo depois de uma rota noturna fica na jornada dessa noite —; mais longe, fica no próprio dia. Uma rota esquecida em andamento continua contando até ser concluída. Direção estimada = tempo de rota em andamento menos as pausas (inclui o tempo parado nos clientes). Só pausas registradas contam como descanso. Pausa aberta há mais de 12 h, ou encerrada só depois de 12 h, foi esquecida: fica fora de todos os cálculos (descanso, direção e fim da jornada) e ganha alerta próprio. Alertas: refeição ausente ou menor que 1 h em jornada acima de 6 h (CLT, art. 71 e art. 235-C, § 2º; só depois que a jornada termina), mais de 6 h de direção estimada sem somar 30 min de descanso (CTB, art. 67-C, § 1º), menos de 11 h desde o fim da jornada anterior (CLT, art. 235-C, § 3º), pausa aberta há mais de 12 h e pausa encerrada depois de mais de 12 h. Período de `from` a `to` (padrão: os últimos 7 dias até hoje), no máximo 31 dias, com datas entre 2000 e 2099; filtros de motorista (`driverId`) e de alerta (`flag`) com as contagens pela regra disjuntiva. Paginado por deslocamento (10 por página; no máximo 100). Permissão: `delivery_manage` (leitura), a mesma da tela Pausas dos motoristas; token de motorista recebe 403 PERMISSION_DENIED.",
        params: businessParam,
        querystring: reportQuery,
        response: {
          200: responses.pauseReport,
          400: responses.reportBadRequest,
          404: responses.notFound,
          500: responses.internalServerError,
        },
      },
    },
    reportController.handle,
  );
}

export { driverPauseRoutes };
