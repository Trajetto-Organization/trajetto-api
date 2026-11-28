import { FastifyInstance } from "fastify";

import { CreateRouteController } from "@/modules/route/usecases/create-route/create-route-controller";
import { UpdateRouteController } from "@/modules/route/usecases/update-route/update-route-controller";

import { ListRoutesController } from "@/modules/route/usecases/list-routes/list-routes-controller";
import { GetRouteController } from "@/modules/route/usecases/get-route/get-route-controller";

import { ReleaseRouteController } from "@/modules/route/usecases/release-route/release-route-controller";
import { StartRouteController } from "@/modules/route/usecases/start-route/start-route-controller";
import { CancelRouteController } from "@/modules/route/usecases/cancel-route/cancel-route-controller";
import { CloseRouteWithPendingController } from "@/modules/route/usecases/close-route-with-pending/close-route-with-pending-controller";

import { AddRouteStopsController } from "@/modules/route/usecases/add-route-stops/add-route-stops-controller";
import { RemoveRouteStopController } from "@/modules/route/usecases/remove-route-stop/remove-route-stop-controller";
import { ReorderRouteStopsController } from "@/modules/route/usecases/reorder-route-stops/reorder-route-stops-controller";
import { AssignmentPreviewController } from "@/modules/route/usecases/assignment-preview/assignment-preview-controller";
import { RemoveRouteStopsController } from "@/modules/route/usecases/remove-route-stops/remove-route-stops-controller";
import { MoveRouteStopsController } from "@/modules/route/usecases/move-route-stops/move-route-stops-controller";
import { SetDeliveryLocationController } from "@/modules/route/usecases/set-delivery-location/set-delivery-location-controller";
import { ListUnroutedDeliveriesController } from "@/modules/route/usecases/list-unrouted-deliveries/list-unrouted-deliveries-controller";
import { ListOpenStopsController } from "@/modules/route/usecases/open-stops/open-stops-controller";

import { RecordDriverPositionsController } from "@/modules/route/usecases/record-driver-positions/record-driver-positions-controller";
import { ControlTowerController } from "@/modules/route/usecases/control-tower/control-tower-controller";
import { DriverTrailController } from "@/modules/route/usecases/driver-trail/driver-trail-controller";
import { RouteMonitoringController } from "@/modules/route/usecases/route-monitoring/route-monitoring-controller";
import { DriverMonitoringController } from "@/modules/route/usecases/driver-monitoring/driver-monitoring-controller";
import { LiveRoutesController } from "@/modules/route/usecases/live-routes/live-routes-controller";

import { MarkStopOnTheWayController } from "@/modules/route/usecases/mark-stop-on-the-way/mark-stop-on-the-way-controller";
import {
  markStopOnTheWayParams,
  markStopOnTheWayResponses,
  markStopOnTheWaySchema,
} from "@/modules/route/usecases/mark-stop-on-the-way/mark-stop-on-the-way-schema";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import { clientSentAtHeaders } from "@/shared/delivery/occurred-at";

import {
  routeSchemas,
  routeResponses,
} from "./documentation/route-documentation";
import { ndjsonList } from "./documentation/ndjson";
import { errorResponse } from "./documentation/common-responses";
import { panelIdempotencyHeaders } from "./documentation/idempotency-documentation";
import {
  controlTowerResponses,
  controlTowerSchemas,
  towerSnapshotDoc,
} from "./documentation/control-tower-documentation";

const createRouteController = new CreateRouteController();
const updateRouteController = new UpdateRouteController();

const listRoutesController = new ListRoutesController();
const getRouteController = new GetRouteController();

const releaseRouteController = new ReleaseRouteController();
const startRouteController = new StartRouteController();
const cancelRouteController = new CancelRouteController();
const closeRouteWithPendingController = new CloseRouteWithPendingController();

const addRouteStopsController = new AddRouteStopsController();
const removeRouteStopController = new RemoveRouteStopController();
const reorderRouteStopsController = new ReorderRouteStopsController();
const assignmentPreviewController = new AssignmentPreviewController();
const removeRouteStopsController = new RemoveRouteStopsController();
const moveRouteStopsController = new MoveRouteStopsController();
const setDeliveryLocationController = new SetDeliveryLocationController();
const listUnroutedDeliveriesController = new ListUnroutedDeliveriesController();
const listOpenStopsController = new ListOpenStopsController();

const recordDriverPositionsController = new RecordDriverPositionsController();
const controlTowerController = new ControlTowerController();
const driverTrailController = new DriverTrailController();
const routeMonitoringController = new RouteMonitoringController();
const driverMonitoringController = new DriverMonitoringController();
const liveRoutesController = new LiveRoutesController();
const markStopOnTheWayController = new MarkStopOnTheWayController();

/**
 * The route is how deliveries are dispatched, so it lives behind the same
 * module switch and the same permission as the deliveries themselves.
 *
 * `delivery_manage` deliberately, rather than a `route_manage` of its own: a
 * user who can write deliveries can already assign a driver to twelve of them
 * through `PATCH /delivery/assign-deliveries`, which is the same act. A second
 * permission would not be a second lock — it would be a second door, and the
 * old one would stay unlocked.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function routeRoutes(app: FastifyInstance) {
  app.post(
    "/create-route/:businessId",
    {
      // Read by the controller: a double click or a resend after a lost
      // answer returns the route the first call made (decision 14.7, §4.7).
      config: { openapi: { headers: panelIdempotencyHeaders } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Planejar uma rota para um motorista",
        description:
          'Cria o dia de trabalho de um motorista e transforma as entregas escolhidas em paradas, na ordem enviada. A rota nasce PLANNED — nada chega ao motorista até ser liberada; depois do commit, as telas da empresa recebem o `routeEvent` `route.created` (só a sala de operações), e as listas de rotas abertas, como a do "Adicionar à rota", releem. Tudo ou nada: uma entrega que não esteja PENDING, seja de outra empresa ou já tenha parada aberta em outra rota recusa o pedido inteiro, nomeando as entregas. O veículo é opcional aqui e obrigatório para liberar. `scheduled_date` é uma data civil (AAAA-MM-DD). Saída e retorno previstos vêm em ISO 8601 COM fuso (horário sem fuso é recusado); a saída deve cair no dia da rota no fuso da empresa (`Business.timezone`) e o retorno não pode ser anterior à saída — 400 VALIDATION_ERROR quando o corpo já mostra o erro, 400 ROUTE_PLAN_INVALID quando só o fuso da empresa revela. `destination` é texto livre (até 160 caracteres). Com o header `Idempotency-Key` (UUID), o reenvio da mesma chave pela mesma empresa responde 201 com a rota já criada e `replayed: true`, sem gravar nada nem anunciar `delivery.assigned` de novo; a mesma chave em outra empresa cria a rota dela. Até 200 paradas na criação.',
        params: routeSchemas.businessIdParam,
        body: routeSchemas.createRoute,
        response: {
          201: routeResponses.routeCreated,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DRIVER_NOT_FOUND (motorista inexistente ou de outra empresa), VEHICLE_NOT_FOUND (veículo inexistente ou de outra empresa), DELIVERY_NOT_FOUND (entrega inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    createRouteController.handle,
  );

  app.get(
    "/list-routes",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Listar rotas",
        description:
          'Responde em application/x-ndjson, NÃO em JSON: uma linha por valor. A PRIMEIRA linha é o envelope `{meta:{total,page,pageSize,searchMeta:{statusCounts,facets}}}` e cada linha seguinte é uma rota com motorista, veículo e as paradas CONTADAS por status (`stopCounts`) — sem as entregas, que ficam no detalhe (get-route); `stops` (id e status) é obsoleto e sai na próxima versão. Chamar response.json() nisso dá erro de parse — leia linha a linha (o front usa parseNDJSON). Quadro paginado; sem `sort`, mais recente primeiro (com `period`, pelo dia da rota, o mais recente primeiro, e no mesmo dia a mais recente criada). Ordenação no servidor por `sort` (created_at, updated_at, code, status, driverName, vehiclePlate, scheduled_date, destination, started_at, completed_at) e `order` (asc|desc), com desempate estável; filtros no servidor por status, motorista (`driverId`) e veículo (`vehicleId`), um ou mais valores separados por vírgula, e pelo dia (AAAA-MM-DD); período pelo dia da rota (`period` = today, 7d, 14d, 30d ou custom com `from`/`to`, até 92 dias e inclusive dias futuros, em dias do fuso da empresa; ausente, todas as datas): entram as rotas desses dias e, quando o período inclui hoje, também as ainda em andamento de dias anteriores (rotas esquecidas) e as de dias anteriores que não saíram (PLANNED ou RELEASED). A tela abre em `period=today`; uma busca que é exatamente o número ou o ID inteiro de uma rota ignora o período (`searchMeta.period.applied = false`); busca livre sobre o nome da rota, o destino, o nome do motorista, o código ("12", "Rota 12" ou "#12"; um número de mais de nove dígitos, como uma chave de NF-e, não é lido como código) e o ID da rota — inteiro ou só o final, como a tabela mostra (pelo menos 8 caracteres hexadecimais). Os cartões (`statusCounts`) e as opções de cada filtro (`facets`) contam o conjunto inteiro da empresa com a busca, o período e os DEMAIS filtros — nunca a página; `searchMeta.period` diz os dias cobertos (null sem período). Ordenação ou filtro fora da lista: 400. Usuário motorista só enxerga as próprias rotas — um driverId enviado por ele é substituído, não somado.',
        querystring: routeSchemas.listRoutes,
        response: {
          200: ndjsonList(
            routeResponses.routeListRow,
            routeResponses.routeListEnvelope.shape.meta,
          ),
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          500: routeResponses.internalServerError,
        },
      },
    },
    listRoutesController.handle,
  );

  app.get(
    "/get-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Consultar uma rota com as paradas",
        description:
          'A tela de detalhe e o que o aplicativo do motorista abre: a rota (com destino, saída/retorno previstos e `plan_version`), as paradas na ordem do despachante, a entrega de cada uma (com o ponto do endereço, quando fixado, e `address_lookup` na parada sem ponto: o endereço ainda sendo procurado ou não localizado) e quantas já foram resolvidas. Para o painel (decisão 14.7) vêm também `driverPosition` — o último ponto do motorista, só em rota liberada ou em andamento e só se gravado nesta rota — e `visitedPoints`, o GPS capturado na chegada e no comprovante, e `stopGeofence`, as paradas com apontamento fora do raio (chegada, comprovante ou ocorrência; plano de 02/11/2026, E5); para o aplicativo do motorista os três vêm vazios. `checklists` (o mais recente da saída e o da chegada) e `fuels` (os abastecimentos feitos na rota) mostram o que aconteceu com o veículo na rota (plano de 02/11/2026, F3), para quem pode vê-los: null com Gestão de Frotas desligada ou num perfil sem a leitura de checklists/abastecimentos. Rota de outra empresa — ou de outro motorista, para um usuário motorista — responde 404, não 403: um "existe mas não é sua" diria a qualquer um quais ids são reais.',
        params: routeSchemas.routeBusinessParams,
        response: {
          200: routeResponses.routeDetail,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          500: routeResponses.internalServerError,
        },
      },
    },
    getRouteController.handle,
  );

  app.patch(
    "/update-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Editar o planejamento de uma rota",
        description:
          "Nome, destino, dia, saída/retorno previstos, motorista e veículo — nunca o status, que muda por liberar/iniciar/cancelar. Só uma rota ainda não executada (PLANNED ou RELEASED) pode ser editada; fora disso, 400 ROUTE_NOT_EDITABLE. Edição parcial: chave ausente mantém, null limpa. A janela é conferida como ficará — o que vier no corpo junto com o que está gravado —, no fuso da empresa: saída no dia da rota e retorno não anterior à saída (400 ROUTE_PLAN_INVALID). Se a rota mudar entre a leitura da tela e o salvar, nada é gravado e a resposta é 409. Trocar motorista ou veículo move também a sombra nas entregas da rota. Toda edição sobe `plan_version`; `expectedPlanVersion` diferente da atual responde 409 ROUTE_PLAN_STALE sem gravar (decisão 14.7). Uma rota liberada não fica sem veículo: `vehicleId: null` numa rota RELEASED responde 400 ROUTE_VEHICLE_REQUIRED (decisão D10; volte a rota ao planejamento para retirá-lo). Trocar o veículo ou o motorista de uma rota RELEASED repete a conferência da liberação: com o checklist da rota exigido pela empresa e nenhuma filial ATIVA para registrá-lo (a do veículo, senão a do motorista, senão a única filial ativa da empresa, pulando as desativadas), 409 ROUTE_BRANCH_REQUIRED com a mensagem que nomeia a placa e o motorista (ou a filial inativa do veículo ou do motorista), e nada muda. Numa rota PLANNED a conferência fica para a liberação.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.updateRoute,
        response: {
          200: routeResponses.routeUpdated,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta), DRIVER_NOT_FOUND (motorista inexistente ou de outra empresa), VEHICLE_NOT_FOUND (veículo inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    updateRouteController.handle,
  );

  app.patch(
    "/release-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Liberar a rota ao motorista, ou devolvê-la ao planejamento",
        description:
          'Liberar é o momento em que a rota deixa de ser rascunho: a partir daqui o motorista a vê no aplicativo e pode sair com ela. Por isso veículo, ao menos uma parada e motorista ativo são exigidos um passo antes de a saída precisar deles — descobrir no pátio que não há veículo custa um telefonema e uma manhã. O status do motorista é relido dentro da transação, com trava compartilhada na linha dele: um motorista inativado no mesmo instante não recebe a rota (400 ROUTE_NOT_RELEASABLE). Um veículo bloqueado ou inativo (por exemplo, bloqueado depois do planejamento) é recusado na liberação com 400 ROUTE_VEHICLE_UNAVAILABLE e a frase que nomeia a placa ("O veículo <placa> está bloqueado e não pode sair em rota. Troque o veículo da rota antes de liberá-la."; "inativo" no outro caso); devolver ao planejamento nunca é recusado por isso. Um veículo ou motorista em outra rota em andamento não recusa a liberação: a rota de amanhã é liberada com a de hoje na rua, e quem espera é a saída. Liberar com o checklist da rota exigido pela empresa (configurações, `checklist_requirement` diferente de NONE, com o módulo Frota ligado) exige que a filial ATIVA em que o checklist do motorista será registrado se resolva: a do veículo, senão a do motorista, senão a única filial ativa da empresa, pulando as desativadas; sem nenhuma, 409 ROUTE_BRANCH_REQUIRED com a mensagem pronta para mostrar ("O checklist desta empresa exige filial: defina a filial do veículo <placa> ou do motorista <nome>."), a rota continua planejada e o motorista não chega a ver um checklist que seria recusado. Quando nada ativo se resolve e o veículo ou o motorista aponta para uma filial INATIVA, a resposta é o mesmo 409 ROUTE_BRANCH_REQUIRED com a frase que nomeia essa filial ("O checklist desta empresa exige filial ativa: a filial <razão social> do veículo <placa> está inativa. Reative a filial ou troque a filial do veículo."; do motorista, o mesmo com o nome). Uma filial inativa com outra ativa para cair não recusa nada: o checklist vai para ela. `released: false` devolve a rota ao planejamento, e só enquanto nenhuma parada foi trabalhada: depois que uma parada tem desfecho, a rota é o registro do que o motorista fez. Pedir o estado em que a rota já está (liberar uma rota liberada, devolver uma planejada) responde 200 com `unchanged: true` e não grava nem avisa ninguém — o duplo clique e o reenvio são inofensivos. `expectedPlanVersion` diferente da versão do plano no momento da liberação: 409 ROUTE_PLAN_STALE (um colega mudou as paradas depois que a tela foi lida). Liberar grava `released_at`; devolver ao planejamento o apaga.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.releaseRoute,
        response: {
          200: routeResponses.routeReleased,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    releaseRouteController.handle,
  );

  app.post(
    "/start-route/:routeId/business/:businessId",
    {
      // Driver surface: the app resends from its outbox after dead networks.
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        // Read by the controller to date a departure queued offline (MOB-08).
        openapi: { headers: clientSentAtHeaders },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "O motorista sai com a rota",
        description:
          'A saída, e a única: leva a rota a IN_PROGRESS e põe a carga na rua — as entregas das paradas abertas passam a IN_TRANSIT no mesmo commit, que é o que a próxima ação do aplicativo (chegada, comprovante) exige. Cada entrega que saiu ganha a linha "Saiu para entrega (Rota N)" no histórico (mudança de status do sistema) e os assinantes de `delivery.in_transit` recebem o webhook dela, no mesmo commit. Só o motorista da própria rota pode iniciá-la; qualquer outro recebe 404. `vehicleId` troca o veículo no pátio. Um veículo bloqueado ou inativo é recusado em toda saída com 400 ROUTE_VEHICLE_UNAVAILABLE ("O veículo <placa> está bloqueado e não pode sair em rota. Fale com o despachante."). Uma segunda saída de um veículo que já está na rua é recusada com 409 ROUTE_VEHICLE_BUSY, com uma frase para o motorista que nomeia a placa e a rota em andamento ("O veículo <placa> ainda está na Rota <N>, em andamento. Esta rota só pode sair quando aquela terminar." e o despachante como saída), sem o nome do outro motorista; o índice do banco continua sendo a garantia contra duas saídas simultâneas. Uma saída enquanto o mesmo motorista já tem OUTRA rota em andamento é recusada com 409 ROUTE_DRIVER_BUSY (conferido sob trava por motorista, então dois toques em duas rotas liberadas não saem os dois), também quando essa outra rota está no mesmo veículo (a segunda viagem do dia no mesmo caminhão): quem está ocupado é o motorista, e a resposta não é a do veículo. O reenvio de uma saída que já aconteceu (sem veículo, ou com o mesmo) — mesmo concorrendo com a primeira tentativa, e mesmo depois de a rota terminar ou ser cancelada na rua — responde 200 com a rota, sem gravar nada. O reenvio que nomeia outro veículo para uma rota que já saiu responde 400 INVALID_ROUTE_TRANSITION (409 ROUTE_STATUS_CONFLICT só quando concorre com a primeira tentativa). Uma rota sem nenhuma parada aberta (todas retiradas depois da liberação) não sai: 400 ROUTE_WITHOUT_STOPS. `occurred_at` (opcional) é o instante do toque no telefone, corrigido pelo header `X-Client-Sent-At`, e vira started_at de uma saída enfileirada sem sinal.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.startRoute,
        response: {
          200: routeResponses.routeStarted,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta), VEHICLE_NOT_FOUND (veículo inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          429: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    startRouteController.handle,
  );

  // "Estou a caminho" (decision 6.4). Addressed by STOP, unlike the arrival:
  // it moves no status (the stop stays PENDING) — it says which of the
  // route's open addresses the driver is heading to, which only the route
  // knows. The stop's outcomes still come only from the delivery endpoints.
  app.post(
    "/on-the-way/:stopId/route/:routeId/business/:businessId",
    {
      config: {
        // Driver surface, resent by the app's outbox after dead networks.
        rateLimit: { max: 60, timeWindow: "1 minute" },
        // Read by the controller to date a mark queued offline (MOB-08).
        openapi: { headers: clientSentAtHeaders },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "O motorista avisa que está a caminho de uma parada",
        description:
          'Só o motorista da rota (outro usuário recebe 403 PERMISSION_DENIED), com a rota em andamento (IN_PROGRESS) e a parada ainda pendente (PENDING). Grava o instante na parada (`on_the_way_at`) e um evento ON_THE_WAY no histórico da entrega (com a rota e, quando vier, a localização), na mesma transação; depois do commit, a torre, o monitoramento e a tela de Rotas recebem `routeEvent` do tipo `route-stop.on_the_way`. O motorista vai a um endereço por vez: marcar outra parada não apaga o instante da anterior, mas só a marcação mais recente da rota vale como "a caminho" (enquanto a parada dela estiver pendente). Mensagem ao destinatário (tópico ON_THE_WAY) só na PRIMEIRA marcação da parada, só se o toque tiver no máximo 60 minutos e só se a empresa tiver modelo ativo de "a caminho" para o canal, a entrega tiver e-mail ou telefone e o destinatário não tiver pedido para parar; ela deixa de sair se a entrega sair de Em rota antes do envio. Sem webhook próprio: o catálogo público não tem tópico de "a caminho". Idempotente por `client_submission_id`: o reenvio da mesma chave responde 200 com o mesmo resultado, mesmo depois de a parada seguir adiante; a mesma chave usada em outro registro responde 409 SUBMISSION_ID_REUSED. Parada inexistente, de outra rota, de outra empresa ou de rota de outro motorista: 404 ROUTE_STOP_NOT_FOUND, a mesma resposta nos quatro casos. `occurred_at` (opcional) é o instante do toque, corrigido pelo header `X-Client-Sent-At`, nunca anterior à saída da rota.',
        params: markStopOnTheWayParams,
        body: markStopOnTheWaySchema,
        response: {
          200: markStopOnTheWayResponses.marked,
          400: markStopOnTheWayResponses.badRequest,
          403: markStopOnTheWayResponses.forbidden,
          404: markStopOnTheWayResponses.notFound,
          409: markStopOnTheWayResponses.conflict,
          429: markStopOnTheWayResponses.rateLimited,
          500: markStopOnTheWayResponses.internalServerError,
        },
      },
    },
    markStopOnTheWayController.handle,
  );

  app.patch(
    "/cancel-route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Cancelar uma rota e liberar o que ela segurava",
        description:
          "O motivo é obrigatório, e não por cerimônia: cancelar uma rota que já saiu joga fora a manhã de um motorista, e a única forma de alguém reconstruir o porquê é quem cancelou dizer na hora. Cancelar também cancela as paradas abertas da rota e devolve as entregas delas ao conjunto sem rota — status e responsável — para que entrem em outra rota; paradas já resolvidas mantêm o desfecho, porque uma entrega comprovada de manhã continua comprovada, aconteça o que acontecer com a rota depois. O motorista é avisado (push e socket) só quando a rota tinha sido liberada ou já tinha saído: uma rota PLANNED nunca foi mostrada a ele. O webhook route.cancelled e a linha de atividade são sempre gravados. Não há exclusão de rota: cancelar é o fim do ciclo.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.cancelRoute,
        response: {
          200: routeResponses.routeCancelled,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    cancelRouteController.handle,
  );

  // "Encerrar com pendências" (plan of 02/11/2026, K11; decision D26): the
  // one write here that ends a route, for the route nobody will finish — a
  // route otherwise closes only when its last stop resolves.
  app.post(
    "/close-with-pending/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Encerrar com pendências uma rota em andamento",
        description:
          'Para a rota esquecida em andamento (decisão D26: começou antes de hoje no fuso da empresa ou há mais de 16 h — o selo "Aberta desde dd/mm"), que segura o motorista (ROUTE_DRIVER_BUSY) e o veículo: só rota IN_PROGRESS. O motivo é obrigatório. Numa transação, sob a trava da rota: as paradas em aberto (PENDING ou ARRIVED) viram CANCELLED; as entregas delas que estavam EM ROTA voltam a PENDENTE, sem motorista nem veículo, cada uma com a linha "Rota N encerrada com pendências: motivo" na linha do tempo; as paradas já resolvidas mantêm o desfecho; a rota fica COMPLETED com `closure_reason` e `completed_at`, sobe `plan_version` e o veículo volta a ficar disponível. O motorista recebe o push de plano alterado e o aviso em tempo real; o ERP recebe `route.completed`; a atividade registra o motivo. O reenvio depois de encerrada responde 200 com `unchanged: true`, sem gravar nem avisar de novo. Rota que não está em andamento (ou que acabou de concluir sozinha): 409 ROUTE_STATUS_CONFLICT. Rota de outra empresa: 404, igual a uma inexistente. Superfície do despachante: token de motorista recebe 403.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.closeRouteWithPending,
        response: {
          200: routeResponses.routeClosedWithPending,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe ou é de outra empresa — a mesma resposta) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    closeRouteWithPendingController.handle,
  );

  // -------------------------------------------------------------------
  // Stops. Three endpoints, all of them planning: adding, removing and
  // ordering are things a dispatcher does before the route leaves.
  //
  // There is deliberately NO endpoint that moves a stop's status. The driver
  // acts on a DELIVERY — arrived, proved it, reported a problem — and the stop
  // is the route's view of that same act, settled in the same commit by the
  // delivery endpoints. A second writer would be a second truth. For the same
  // reason nothing here closes a route: it ends because its last stop did —
  // the one exception being close-with-pending above (K11, D26), for the
  // route nobody will finish, which cancels the open stops rather than
  // inventing an outcome for them.
  // -------------------------------------------------------------------

  app.post(
    "/add-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Adicionar entregas à rota como paradas",
        description:
          'Entram no fim da ordem atual — onde uma parada fica é decisão do despachante, tomada arrastando. Rota PLANNED, RELEASED ou IN_PROGRESS aceita paradas (K12); concluída ou cancelada, 409 ROUTE_STATUS_CONFLICT nomeando a rota e o estado ("A Rota 8 foi cancelada e não aceita novas entregas. Atualize a lista e escolha outra rota."), antes de qualquer outra verificação — inclusive a de entrega que já é parada desta rota —, e o mesmo quando ela termina entre a verificação e a trava. Em rota EM ANDAMENTO a entrega já sai para a rua no mesmo commit (EM ROTA, com o motorista e o veículo da rota, a linha "Saiu para entrega (Rota N)" no histórico e o webhook `delivery.in_transit`) e quem espera recebe o aviso "saiu para entrega" (`delivery.dispatched`), como na saída da rota. Em rota liberada ou em andamento o motorista é avisado em tempo real (`routeEvent` `route.stops_changed`) e por push de plano alterado. "Reentregar": com `redelivery` (`reasonId` do catálogo de motivos de status e `note` opcional), as entregas com INSUCESSO da lista voltam a PENDENTE com a linha de mudança de status citando o motivo e entram na rota, tudo na mesma transação; motivo inexistente ou de outra empresa → 404 STATUS_CHANGE_REASON_NOT_FOUND, desativado → 400 STATUS_CHANGE_REASON_INACTIVE; sem `redelivery`, entrega com insucesso → 400 DELIVERY_NOT_ROUTABLE; entrega que mudou de status no meio → 409 DELIVERY_STATUS_CONFLICT. Idempotente: uma entrega que já é parada aberta DESTA rota não é erro — volta em `alreadyOnRoute` (o reenvio depois de resposta perdida responde 201 com `added: 0`). Uma entrega em OUTRA rota (planejada, liberada ou em andamento) é 409 DELIVERY_ALREADY_ON_ROUTE, nomeando a entrega e a rota — também quando ela entrou lá entre a conferência e a gravação; para trazê-la use move-stops. No máximo 200 paradas abertas por rota (400 ROUTE_STOPS_LIMIT), contadas sob trava. `expectedPlanVersion` diferente da atual: 409 ROUTE_PLAN_STALE. Cada entrega ganha a linha "Adicionada à Rota N" no histórico e o anúncio `delivery.assigned`, no mesmo commit. Tudo ou nada.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.addStops,
        response: {
          201: routeResponses.stopsAdded,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta), DELIVERY_NOT_FOUND (entrega inexistente ou de outra empresa), STATUS_CHANGE_REASON_NOT_FOUND (o motivo de `redelivery` não existe ou é de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    addRouteStopsController.handle,
  );

  app.delete(
    "/remove-stop/:stopId/route/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Tirar uma entrega da rota",
        description:
          "Excluída, não cancelada, e é o único ponto deste módulo em que uma linha some: uma parada retirada durante o planejamento nunca aconteceu, enquanto uma parada CANCELLED significa que o motorista foi mandado para lá e isso foi desfeito. A entrega volta ao conjunto sem rota mantendo o próprio status — sair de uma rota nunca o mudou. Uma parada que não existe, pertence a outra rota ou está numa rota que já saiu responde o mesmo 404. Mantido por compatibilidade: é o remove-stops com uma parada só (mesma versão do plano, histórico e aviso em tempo real).",
        params: routeSchemas.routeStopParams,
        response: {
          200: routeResponses.stopRemoved,
          400: routeResponses.genericError,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "ROUTE_STOP_NOT_FOUND (a parada não existe, é de outra rota ou a rota já saiu) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          500: routeResponses.internalServerError,
        },
      },
    },
    removeRouteStopController.handle,
  );

  app.patch(
    "/reorder-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Reescrever a ordem das paradas",
        description:
          "Recebe a lista COMPLETA, não um movimento: uma instrução de mover aplicada a uma rota que um colega mudou nesse meio-tempo produz em silêncio uma ordem que ninguém pediu, enquanto uma lista completa ou descreve a rota como ela está ou descreve uma que não existe mais — e a segunda é recusada com 409 ROUTE_REORDER_MISMATCH, para o despachante atualizar a tela e refazer. Um id de parada repetido é 400, que é outro problema e não se resolve atualizando. Só rota PLANNED ou RELEASED pode ser reordenada: depois da saída, a ordem é o que o motorista está seguindo na tela do celular (409). A ordem igual à atual responde 200 sem gravar nem avisar ninguém. `expectedPlanVersion` diferente da atual: 409 ROUTE_PLAN_STALE. Em rota liberada o motorista é avisado em tempo real.",
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.reorderStops,
        response: {
          200: routeResponses.stopsReordered,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    reorderRouteStopsController.handle,
  );

  app.post(
    "/remove-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Tirar várias entregas da rota",
        description:
          'Retira paradas PENDING de uma rota PLANNED ou RELEASED, numa transação (decisão 14.7). As paradas são excluídas — uma parada retirada no planejamento nunca aconteceu — e as entregas voltam ao conjunto sem rota mantendo o próprio status, cada uma com a linha "Retirada da Rota N" no histórico. Idempotente: um id que não é (ou já não é) parada pendente desta rota volta em `alreadyGone`, não é erro. Uma rota liberada que fica vazia NÃO é cancelada: `routeEmptied: true` e a tela oferece voltar ao planejamento ou cancelar. Rota que já saiu: 409 ROUTE_STATUS_CONFLICT. `expectedPlanVersion` diferente da atual: 409 ROUTE_PLAN_STALE. Rota inexistente ou de outra empresa: 404 DELIVERY_ROUTE_NOT_FOUND. Token de motorista: 403 DRIVER_CANNOT_MANAGE_DELIVERIES.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.removeStops,
        response: {
          200: routeResponses.stopsRemoved,
          400: errorResponse,
          401: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    removeRouteStopsController.handle,
  );

  app.post(
    "/move-stops/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Trazer entregas de outras rotas (ou sem rota) para esta",
        description:
          'O "Adicionar à rota" da tabela de Entregas (decisão 14.7): numa transação só, tira as entregas das rotas PLANNED/RELEASED em que estão e as acrescenta no fim desta. Entregas sem rota simplesmente entram; as que já são paradas desta rota voltam em `alreadyOnRoute`. As rotas envolvidas são travadas em ordem de id, então mover de A para B e de B para A ao mesmo tempo não trava o banco. Uma rota de origem LIBERADA que fica vazia é cancelada com o motivo "Todas as paradas foram movidas para a Rota N." e o motorista dela é avisado; uma planejada fica. Entrega numa rota que já saiu: 409 DELIVERY_ON_STARTED_ROUTE, nomeando-a, sem gravar nada. Rota destino concluída ou cancelada: 409 ROUTE_STATUS_CONFLICT nomeando a rota e o estado, antes de olhar as entregas (nenhuma origem é tocada e nenhuma entrega volta em `alreadyOnRoute`). As mesmas regras do add-stops: só PENDING, teto de 200 paradas, `expectedPlanVersion` (da rota destino), `delivery.assigned` por entrega e o histórico nas duas rotas. Rota destino EM ANDAMENTO: como no add-stops, a entrega já sai para a rua no mesmo commit (EM ROTA, "Saiu para entrega (Rota N)", o webhook `delivery.in_transit`) e quem espera recebe o aviso "saiu para entrega" (`delivery.dispatched`). Entrega que entrou em outra rota entre a conferência e a gravação: 409 DELIVERY_ALREADY_ON_ROUTE, nomeando a entrega e a rota.',
        params: routeSchemas.routeBusinessParams,
        body: routeSchemas.moveStops,
        response: {
          200: routeResponses.stopsMoved,
          400: errorResponse,
          401: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_ROUTE_NOT_FOUND (a rota não existe, é de outra empresa ou, para um motorista, de outro motorista — a mesma resposta) (a de origem ou a de destino), DELIVERY_NOT_FOUND (entrega inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          409: routeResponses.conflictError,
          500: routeResponses.internalServerError,
        },
      },
    },
    moveRouteStopsController.handle,
  );

  app.get(
    "/unrouted-deliveries/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Entregas sem rota, para montar uma rota",
        description:
          'O seletor "Adicionar entregas" da página da rota (decisão 14.7): entregas PENDING da empresa sem nenhuma parada aberta (PENDING ou ARRIVED) em rota alguma — o mesmo predicado do índice único parcial que impede uma entrega em duas rotas. Mais antigas primeiro pela data prevista (sem data por último), depois pela criação; até 100 por página. Seletor com cursor (plano de 02/11/2026, G9): a primeira página traz `total`, `facets` e `meta.nextCursor`; as seguintes, pedidas com `cursor`, começam depois da última linha vista — sem repetir nem pular quando colegas roteiam entregas no meio — e não recalculam as contagens. `page` continua aceito (deslocamento) para a versão do painel ainda em uso. Cursor adulterado: 400 INVALID_CURSOR. Busca por código, número da NF, chave, destinatário, cidade ou rua; filtros por embarcador, cidade, UF, tipo e intervalo de data prevista (com ou sem as sem data). `meta.facets` conta cada filtro com os DEMAIS aplicados. Superfície do despachante: token de motorista recebe 403 DRIVER_CANNOT_MANAGE_DELIVERIES.',
        params: routeSchemas.businessIdParam,
        querystring: routeSchemas.listUnroutedDeliveries,
        response: {
          200: routeResponses.unroutedDeliveries,
          400: errorResponse,
          401: errorResponse,
          403: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    listUnroutedDeliveriesController.handle,
  );

  app.get(
    "/open-stops/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Em que rota está cada entrega de uma seleção",
        description:
          'Para o diálogo "Adicionar à rota" (decisão 14.7): para cada entrega com parada aberta, a rota que a segura (código e status). Entrega sem rota não aparece. Lido pela empresa da rota: um id de outra empresa simplesmente não tem resposta. Até 100 ids. Token de motorista: 403 DRIVER_CANNOT_MANAGE_DELIVERIES.',
        params: routeSchemas.businessIdParam,
        querystring: routeSchemas.openStops,
        response: {
          200: routeResponses.openStops,
          400: errorResponse,
          401: errorResponse,
          403: routeResponses.genericError,
          500: routeResponses.internalServerError,
        },
      },
    },
    listOpenStopsController.handle,
  );

  app.patch(
    "/set-delivery-location/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Fixar no mapa onde fica o endereço da entrega",
        description:
          '"Fixar no mapa" da página da rota (decisão 14.7): grava o ponto do ENDEREÇO (`geo_source: MANUAL`), que é plano e não prova — o GPS do comprovante não muda. `{ clear: true }` apaga o ponto. Ponto fora do Brasil: 400 DELIVERY_LOCATION_INVALID (um clique fora do país é quase sempre engano). Entrega DELIVERED ou CANCELLED: 400 DELIVERY_LOCATION_LOCKED. Entrega de outra empresa: 404 DELIVERY_NOT_FOUND, igual a uma que não existe. Se a entrega é parada aberta de uma rota PLANNED/RELEASED, a versão do plano dessa rota sobe e, se liberada, o motorista é avisado. Numa rota IN_PROGRESS a versão não sobe (o ponto não muda parada nem ordem) e o app do motorista recebe só o `routeEvent` silencioso `route-stop.located`, sem aviso nem push: ele relê o dia, e a navegação e a geocerca passam a usar o ponto novo. Gravar o mesmo ponto de novo é inofensivo. Depois do pino, as outras entregas abertas (PENDING ou IN_TRANSIT) da mesma empresa no mesmo endereço (rua, número, bairro, cidade e UF; o CEP não conta) e ainda sem ponto recebem o mesmo ponto, gravado como `GEOCODER` ("Pelo endereço"), sem subir versão de plano: as páginas das rotas delas são avisadas por `routeStopsLocated` e o motorista de uma rota liberada ou em andamento por `route-stop.located`, como num ponto achado pelo endereço. Um endereço sem número (s/n) não dá o pino a ninguém: sem número, o endereço nomeia uma rua, não uma porta. Nunca sobrescreve um ponto da própria entrega. As cópias que esta entrega já deu acompanham o pino, na mesma gravação: as abertas da mesma empresa que ainda estão no mesmo endereço e ainda têm exatamente o ponto anterior dela mudam para o ponto novo; apagar o pino apaga o ponto delas, e elas voltam para a localização automática como uma entrega nova sem ponto. Uma cópia fixada à mão depois, uma com o endereço mudado, uma encerrada e qualquer entrega de outra empresa não mudam. Elas são avisadas do mesmo jeito (`routeStopsLocated` e `route-stop.located`). `propagated` diz quantas entregas o pino alcançou.',
        params: routeSchemas.deliveryLocationParams,
        body: routeSchemas.setDeliveryLocation,
        response: {
          200: routeResponses.deliveryLocation,
          400: errorResponse,
          401: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DELIVERY_NOT_FOUND (entrega inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          500: routeResponses.internalServerError,
        },
      },
    },
    setDeliveryLocationController.handle,
  );

  app.get(
    "/assignment-preview/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Avisos sobre um par motorista e veículo antes de atribuir",
        description:
          'O que os diálogos "Atribuir Motorista e Veículo" e "Planejar rota" mostram antes de confirmar: os veículos em operação pelos quais o motorista é responsável (e o único deles, para pré-selecionar), o responsável e o status do veículo escolhido, o fuso da empresa e os avisos — motorista ou veículo com rota em andamento, com outra rota no mesmo dia, veículo de outro responsável ou fora de operação e, pela decisão 8.5, CNH vencida no dia da rota, categoria da CNH que não cobre a exigida pelo tipo do veículo (ou não cadastrada), ordem de serviço aberta e último checklist reprovado. Nada bloqueia: o que o banco recusa continua recusado na saída. Só leitura, do despachante: token de motorista recebe 403 DRIVER_CANNOT_MANAGE_DELIVERIES. Motorista ou veículo de outra empresa responde 404, igual a um que não existe. O dia é AAAA-MM-DD; ausente, hoje no fuso da empresa.',
        params: routeSchemas.businessIdParam,
        querystring: routeSchemas.assignmentPreview,
        response: {
          200: routeResponses.assignmentPreview,
          400: errorResponse,
          403: routeResponses.genericError,
          404: routeResponses.notFound(
            "DRIVER_NOT_FOUND (motorista inexistente ou de outra empresa), VEHICLE_NOT_FOUND (veículo inexistente ou de outra empresa) ou TENANT_NOT_FOUND (a empresa do caminho não existe).",
          ),
          500: routeResponses.internalServerError,
        },
      },
    },
    assignmentPreviewController.handle,
  );

  app.post(
    "/positions",
    {
      /**
       * The busiest route in the product, by an order of magnitude.
       *
       * A phone takes a point every 15 s and flushes every 60 s or 20
       * points — about 2,400 points per driver in a ten-hour day; at 20k
       * drivers, ~333 requests and ~1,333 points a second — and a whole
       * fleet does it at once. Each answer says when to flush next
       * (`nextFlushAfterMs`, plano-escala F2-26), longer when this replica
       * is pressed, so the fleet slows down instead of piling retries on it. The ceiling is per user (the rate limiter keys on the
       * session), so one phone in a loop cannot spend the budget of the fleet
       * — and 120 a minute is far above the normal one request or so, which
       * leaves room for a device draining its outbox after a dead zone
       * without letting one run away.
       */
      config: {
        rateLimit: { max: 120, timeWindow: "1 minute" },
        // The session cache may answer (plano-escala F5-23, ADR 0015):
        // off unless SESSION_CACHE_TTL_MS is set.
        sessionCache: true,
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "O aplicativo do motorista informa onde está",
        description:
          "O motorista vem da SESSÃO e nunca do corpo: um driverId enviado aqui deixaria qualquer telefone escrever a trilha de qualquer pessoa, e a trilha é com o que uma disputa se resolve. Só grava enquanto uma rota do motorista está IN_PROGRESS — fora disso responde `tracking: false` e o app PARA, porque continuar é gastar a bateria de alguém num mapa que ninguém está olhando. Pontos imprecisos demais, com coordenada impossível ou com relógio adiantado são descartados silenciosamente e contados em `rejected`: o app é offline-first e reenvia, então recusar o lote faria o telefone repetir o mesmo ponto ruim para sempre. Um acúmulo de região sem sinal é aceito inteiro até o teto do lote; só o ÚLTIMO ponto vai para o websocket (evento `driverPosition` na sala de posições da empresa, `positions:<businessId>`, e também na de operações enquanto `SOCKET_POSITIONS_ON_OPERATIONS_ROOM=true`), senão cada painel aberto redesenharia o mesmo ponto duzentas vezes. O app envia a cada 60 s ou 20 pontos; a resposta diz em `nextFlushAfterMs` quanto esperar antes do próximo envio, mais quando a réplica que respondeu está ocupada (120 s) ou no limite (300 s).",
        body: controlTowerSchemas.recordPositions,
        response: {
          200: controlTowerResponses.positionsRecorded,
          400: errorResponse,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    recordDriverPositionsController.handle,
  );

  app.get(
    "/control-tower",
    {
      // The session cache may answer (plano-escala F5-23, ADR 0015): off
      // unless SESSION_CACHE_TTL_MS is set.
      config: { sessionCache: true },
      onRequest: [ensureAuthenticated],
      // allowDriver:false (plan of 02/11/2026, H5): defence in depth in front
      // of the use case's own refusal — the driver's delivery_manage grant is
      // for their own work, and the tower is the whole fleet's.
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Tudo o que a torre de controle desenha, numa requisição",
        description:
          'Um endpoint e não cinco: o painel atualiza tudo junto a cada 30 s. "Hoje" é o dia da EMPRESA, no fuso dela (`Business.timezone`), nunca o do servidor. O funil conta os documentos ATIVOS no dia — com parada numa rota do dia (ou em andamento), na rua agora, ou resolvidos no dia (entregue por `delivered_at`, insucesso pelo fato que o causou, cancelado pela mudança de status) —, a mesma definição do Monitoramento. "Finalizadas" = entregues + insucessos + canceladas resolvidos no dia. A pontualidade julga só as rotas do dia, com a hora atual: antes do horário planejado + 15 min a rota está "aguardando" (fora da taxa); depois disso, sem sair, conta como atraso. O mapa olha 12 h para trás; o ponto de rota concluída fica 2 h com estado `ended` e depois sai, e "sem reportar" (`silent`) só vale para rota em andamento. `activeRoutes` lista toda rota em andamento, inclusive a que não tem posição; a que começou antes de hoje (fuso da empresa) ou há mais de 16 h vem com `stale: true` e `openSince` (decisão D26), e `inherited` conta as paradas ainda abertas nessas rotas, que o funil inclui como Em rota. Os eventos juntam o histórico das entregas, as ocorrências e a saída, conclusão e cancelamento de rotas do dia. Superfície do gestor: token de motorista recebe 403. ' +
          towerSnapshotDoc.description,
        querystring: controlTowerSchemas.controlTower,
        response: {
          200: controlTowerResponses.controlTower,
          304: towerSnapshotDoc.notModified,
          400: controlTowerResponses.error,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    controlTowerController.handle,
  );

  app.get(
    "/live",
    {
      onRequest: [ensureAuthenticated],
      // The tower's gates (wave 4): the same module, the same read key, the
      // same refusal of a driver token. It is the tower's list without the
      // tower's cost, for the manager's phone.
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "As rotas na rua agora, enxutas, para o app do gestor",
        description:
          'As rotas da empresa em andamento (de qualquer dia: a esquecida aberta entra, com `stale`) e as liberadas para hoje (dia da empresa, no fuso dela) ainda não iniciadas, uma linha por rota: número, situação, motorista, placa, paradas (`stops_total` sem as canceladas; `stops_resolved` entregues ou com insucesso), pedidos de autorização vivos da rota (`pending_authorizations`, a mesma conta da fila), o último ponto do motorista (`position`, só se das últimas 12 h, a janela do mapa da torre) e `last_signal_at` (o último ponto, por mais antigo). Sem funil, eventos nem pontualidade: são três leituras pequenas (o fuso da empresa, as rotas da página com as contagens e as posições numa consulta, e os pedidos pendentes da página), contra as cerca de oito da torre. Ordem: em andamento primeiro, depois as liberadas, cada grupo pelo número. No máximo 500 linhas; havendo mais, `meta.truncated` é true e `meta.nextCursor` abre a próxima página (cursor inválido: 400 INVALID_CURSOR). `meta.silentAfterMs` é o limite de "Sem sinal" da torre (10 min) e `meta.generatedAt` o relógio do servidor, para o "há N min". O MASTER envia `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED); os demais leem a própria empresa, e nomear outra é 403 TENANT_ACCESS_DENIED. Superfície do gestor, com as guardas da torre: `delivery_manage` de leitura e o módulo Entregas (403 PERMISSION_DENIED, MODULE_NOT_ENABLED); token de motorista recebe 403. Só a primeira página (sem `cursor`) sai da foto; uma página com cursor é lida na hora, sem `ETag`. ' +
          towerSnapshotDoc.description,
        querystring: controlTowerSchemas.liveRoutes,
        response: {
          200: controlTowerResponses.liveRoutes,
          304: towerSnapshotDoc.notModified,
          400: controlTowerResponses.error,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    liveRoutesController.handle,
  );

  app.get(
    "/driver-trail/:driverId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Por onde um motorista passou num dia",
        description:
          "Pedido só quando alguém abre um motorista, nunca na atualização da torre. O dia é o da empresa, no fuso dela: `day` (AAAA-MM-DD) cobre da meia-noite à meia-noite desse fuso; ausente, o dia de hoje da empresa. O resultado é afinado para no máximo quatrocentos pontos, e `recorded` diz quantos existem de verdade, porque quem visse só o desenhado concluiria que o telefone parou de reportar. Um motorista de outra empresa responde o mesmo 404 de um que não existe. Com `routeId` (decisão 14.7), só os pontos gravados durante essa rota, da saída à conclusão (o dia é ignorado); rota ainda não iniciada devolve trilha vazia; rota de outra empresa ou de outro motorista: 404 DELIVERY_ROUTE_NOT_FOUND.",
        params: controlTowerSchemas.driverTrailParams,
        querystring: controlTowerSchemas.driverTrailQuery,
        response: {
          200: controlTowerResponses.driverTrail,
          400: controlTowerResponses.error,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "DRIVER_NOT_FOUND (motorista inexistente ou de outra empresa — a mesma resposta), DELIVERY_ROUTE_NOT_FOUND (rota de outra empresa ou de outro motorista) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    driverTrailController.handle,
  );

  app.get(
    "/monitoring",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Monitoramento por rota: progresso e cada entrega",
        description:
          "As rotas do dia da empresa (no fuso dela) que não foram canceladas — e, quando o dia é hoje, também as ainda em andamento de dias anteriores —, primeiro as em andamento, depois as liberadas, as planejadas e as concluídas. Com `period` (today, 7d, 14d, 30d ou custom com `from`/`to`, até 92 dias, pelo dia da rota), as rotas desses dias, com as em andamento quando o período inclui hoje, e em cada grupo o dia mais recente primeiro; `period=today` é o mesmo quadro de sem período, `data.period` diz os dias (null sem período) e `day` junto com `period` dá 400. Cada rota traz o percentual de conclusão (entregues + insucessos sobre o total sem as canceladas), a taxa de entregues e uma entrada por parada, na ordem da rota. Paginado por deslocamento (20 por página; no máximo 50). Superfície do gestor: token de motorista recebe 403.",
        querystring: controlTowerSchemas.routeMonitoring,
        response: {
          200: controlTowerResponses.routeMonitoring,
          400: controlTowerResponses.error,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    routeMonitoringController.handle,
  );

  app.get(
    "/monitoring/drivers",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["route"],
        summary: "Monitoramento por motorista: a carga do dia de cada um",
        description:
          "Os documentos ativos no dia da empresa (no fuso dela) — a mesma definição do funil da torre —, divididos por motorista: pendentes nas rotas do dia (ou numa rota ainda em andamento; nunca as de outros dias), na rua agora, entregues no dia e insucessos no dia (pelo fato que causou a falha, não pela última edição). Documento sem motorista e cancelamentos não entram na carga de ninguém. Uma linha por motorista, quem está na rua primeiro. Superfície do gestor: token de motorista recebe 403.",
        querystring: controlTowerSchemas.driverMonitoring,
        response: {
          200: controlTowerResponses.driverMonitoring,
          400: controlTowerResponses.error,
          401: controlTowerResponses.error,
          403: controlTowerResponses.error,
          404: controlTowerResponses.notFound(
            "USER_NOT_FOUND (o usuário da sessão não existe mais).",
          ),
          429: controlTowerResponses.error,
          500: controlTowerResponses.internalServerError,
        },
      },
    },
    driverMonitoringController.handle,
  );
}

export { routeRoutes };
