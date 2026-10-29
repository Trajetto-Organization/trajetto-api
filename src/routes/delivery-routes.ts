import { FastifyInstance } from "fastify";

import { CreateDeliveryController } from "@/modules/delivery/usecases/create-delivery/create-delivery-controller";
import { ListDeliveryController } from "@/modules/delivery/usecases/list-delivery/list-delivery-controller";

import { ListOccurrencesController } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-controller";
import { occurrenceFeedSearchMetaDoc } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-documentation";
import { OperationSummaryController } from "@/modules/delivery/usecases/operation-summary/operation-summary-controller";

import { GetDeliveryController } from "@/modules/delivery/usecases/get-delivery/get-delivery-controller";
import { UpdateDeliveryController } from "@/modules/delivery/usecases/update-delivery/update-delivery-controller";

import { UpdateDeliveryStatusController } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-controller";
import { AssignDeliveriesController } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-controller";

import { ListMyDeliveriesController } from "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-controller";
import { StartDriverRouteController } from "@/modules/delivery/usecases/start-driver-route/start-driver-route-controller";

import { RegisterDeliveryArrivalController } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-controller";
import { RegisterDeliveryProofController } from "@/modules/delivery/usecases/register-delivery-proof/register-delivery-proof-controller";
import { ReportDeliveryOccurrenceController } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-controller";
import { DecideOccurrenceAuthorizationController } from "@/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-controller";
import { ListPendingAuthorizationsController } from "@/modules/delivery/usecases/authorize-occurrence/list-pending-authorizations-controller";

import { ImportDeliveryXmlController } from "@/modules/delivery/usecases/import-delivery-xml/import-delivery-xml-controller";

import { ExportDeliveryController } from "@/modules/delivery/usecases/export-delivery/export-delivery-controller";
import { ExportOccurrenceController } from "@/modules/delivery/usecases/export-occurrence/export-occurrence-controller";

import { GetProofDocumentController } from "@/modules/delivery/usecases/get-proof-document/get-proof-document-controller";

import { SaveMessageTemplateController } from "@/modules/delivery/usecases/save-message-template/save-message-template-controller";
import { ListMessageTemplatesController } from "@/modules/delivery/usecases/list-message-templates/list-message-templates-controller";

import { ListProofAuditsController } from "@/modules/delivery/usecases/list-proof-audits/list-proof-audits-controller";
import { ReviewProofAuditController } from "@/modules/delivery/usecases/review-proof-audit/review-proof-audit-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  deliverySchemas,
  deliveryResponses,
} from "./documentation/delivery-documentation";

import {
  proofDocumentSchemas,
  proofDocumentResponses,
} from "./documentation/proof-document-documentation";

import {
  proofAuditSchemas,
  proofAuditResponses,
} from "./documentation/proof-audit-documentation";
import { itemOf, ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { deliveryListSearchMetaDoc } from "@/modules/delivery/usecases/list-delivery/list-delivery-documentation";
import { panelIdempotencyHeaders } from "./documentation/idempotency-documentation";
import { errorResponse } from "./documentation/common-responses";
import { idempotencyHeaders } from "./documentation/idempotency-documentation";
import { startDriverRouteSchema } from "@/schemas/start-driver-route-schema";
import { clientSentAtHeaders } from "@/shared/delivery/occurred-at";
import {
  documentedAs,
  exportFileResponse,
} from "./documentation/doc-only-responses";

const createDeliveryController = new CreateDeliveryController();
const listDeliveryController = new ListDeliveryController();

const listOccurrencesController = new ListOccurrencesController();
const operationSummaryController = new OperationSummaryController();

const getDeliveryController = new GetDeliveryController();
const updateDeliveryController = new UpdateDeliveryController();

const updateDeliveryStatusController = new UpdateDeliveryStatusController();
const assignDeliveriesController = new AssignDeliveriesController();

const listMyDeliveriesController = new ListMyDeliveriesController();
const startDriverRouteController = new StartDriverRouteController();

const registerDeliveryArrivalController =
  new RegisterDeliveryArrivalController();
const registerDeliveryProofController = new RegisterDeliveryProofController();
const reportDeliveryOccurrenceController =
  new ReportDeliveryOccurrenceController();
const decideOccurrenceAuthorizationController =
  new DecideOccurrenceAuthorizationController();
const listPendingAuthorizationsController =
  new ListPendingAuthorizationsController();

const importDeliveryXmlController = new ImportDeliveryXmlController();

const exportDeliveryController = new ExportDeliveryController();
const exportOccurrenceController = new ExportOccurrenceController();

const getProofDocumentController = new GetProofDocumentController();

const saveMessageTemplateController = new SaveMessageTemplateController();
const listMessageTemplatesController = new ListMessageTemplatesController();

const listProofAuditsController = new ListProofAuditsController();
const reviewProofAuditController = new ReviewProofAuditController();

// A batch of NF-e files is bigger than any other JSON body in the API, so
// this route (and only it) raises the limit: 25 files of up to 512 KB.
const IMPORT_BODY_LIMIT = 13 * 1024 * 1024;

const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function deliveryRoutes(app: FastifyInstance) {
  app.post(
    "/create-delivery/:businessId",
    {
      // Documentation only; see idempotency-documentation (IDEMP-14).
      config: { openapi: { headers: panelIdempotencyHeaders } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Cria uma entrega (cadastro manual)",
        description:
          "Cadastra uma entrega com destinatário, endereço, chave da NF-e opcional (44 dígitos, âncora da deduplicação) e itens da carga. `kind` diz o tipo: DELIVERY (entrega, o padrão quando ausente) ou SERVICE_ORDER (ordem de serviço, ex.: recolher cestos retornáveis); PICKUP só vem da planilha. A data prevista é um dia (AAAA-MM-DD, sem hora). Motorista e veículo não vêm aqui: atribuir é pela atribuição, que cria a rota. Embarcador desativado → 400 SHIPPER_INACTIVE; embarcador inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND; chave já usada na empresa (inclusive numa corrida entre dois envios) → 409 DELIVERY_INVOICE_KEY_EXISTS.",
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.createDelivery,
        response: {
          201: deliveryResponses.deliveryCreated,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    createDeliveryController.handle,
  );

  app.post(
    "/import-xml/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      bodyLimit: IMPORT_BODY_LIMIT,

      // Up to 25 NF-e per call, parsed synchronously: a large one blocks the
      // event loop for ~57 ms, so a loop of full imports was seconds of CPU a
      // second for everyone on the replica.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Importa entregas de XMLs de NF-e",
        description:
          "Cada XML vira uma entrega, e a importação inteira vira uma linha em Importações (origem NFE_XML, com relatório por arquivo e estorno), como a planilha. Arquivos são processados um a um: um arquivo ruim não derruba o lote. Reimportar a mesma nota é duplicada (a chave de acesso é a identidade). O emitente vira o embarcador — casado por CNPJ, ou pelo nome quando o embarcador cadastrado não tem CNPJ; criado se não existir —, a menos que `shipperId` force um. Embarcador desativado: forçado → 400 SHIPPER_INACTIVE; emitente → a nota sai inválida. Embarcador forçado inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND. A data prevista é um dia (AAAA-MM-DD). Emite `catalogChanged` (shipper) quando cria embarcadores.",
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.importDeliveryXml,
        response: {
          200: deliveryResponses.deliveriesImported,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    importDeliveryXmlController.handle,
  );

  app.get(
    "/list-delivery",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista as entregas",
        description:
          "Tabela paginada no servidor: ordena por `sort`/`order` e filtra por status, embarcador, motorista e tipo (`kind`; cada filtro com um ou mais valores separados por vírgula) e pelo período de criação (`period` = today, 7d, 14d, 30d ou custom com `from`/`to`, até 92 dias, em dias do fuso da empresa; ausente, todas as datas). A tela abre em `period=today`; uma busca que é exatamente o ID, o pedido, a chave ou o número da NF de uma entrega ignora o período (`searchMeta.period.applied = false`), para o link de uma notificação achar a entrega antiga. Busca livre (ID, destinatário, pedido, chave e número da NF-e, cidade, nome ou CNH do motorista). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões por status e as opções dos filtros com as contagens (cada uma com os demais filtros aplicados). Motorista só vê as próprias entregas.",
        querystring: deliverySchemas.listDeliveries,
        response: {
          200: ndjsonList(
            itemOf(deliveryResponses.deliveryList),
            offsetMetaWith(deliveryListSearchMetaDoc),
          ),
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    listDeliveryController.handle,
  );

  app.get(
    "/list-occurrences",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("occurrence_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista as ocorrências da operação",
        description:
          'Todas as ocorrências da empresa numa tabela paginada: tipo (com a gravidade), entrega, quem registrou e as fotos em URLs assinadas. Ordena no servidor (`sort`/`order`) e filtra por gravidade, tipo e status da entrega, cada filtro com um ou mais valores separados por vírgula, além da busca livre (ID da ocorrência, ID da entrega, destinatário ou nome do tipo). `sort=created_at` ordena pela chegada da ocorrência ao servidor (coluna "Recebida em"); `occurred_at` é a hora registrada no aparelho (o toque do motorista, enviada também com sinal); num envio que esperou na fila sem sinal fica até 7 dias antes da chegada, e não é chave de ordenação. A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções dos filtros com as contagens. Motoristas recebem 403 (`PERMISSION_DENIED`): o app lê as ocorrências pelas rotas da própria entrega.',
        querystring: deliverySchemas.listOccurrences,
        response: {
          200: ndjsonList(
            deliveryResponses.occurrenceFeedRow,
            offsetMetaWith(occurrenceFeedSearchMetaDoc),
          ),
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    listOccurrencesController.handle,
  );

  app.get(
    "/operation-summary",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Resumo da operação (monitoramento)",
        description:
          "Os números do monitoramento, na mesma definição do dia da torre de controle (decisão 7.1): designadas são as pendentes com motorista em rota do dia (programada para hoje ou ainda em andamento) — rota de amanhã, rota de ontem que não saiu e entrega com motorista sem rota não contam; em rota é o que está na rua agora; entregues e insucessos são os documentos do dia (entregues por delivered_at, insucessos pelo último fato de falha, e os resolvidos em rota do dia). À parte, dois números que a torre não tem: sem rota (pendentes sem motorista, de qualquer data) e ocorrências relatadas por motoristas no dia. Traz o quadro por motorista, quem está na rua primeiro. 'Hoje' é o dia civil no fuso da empresa (Business.timezone). Superfície do gestor: token de motorista é recusado (403 DRIVER_CANNOT_VIEW_PANELS); empresa de outro tenant, 403 TENANT_ACCESS_DENIED.",
        querystring: deliverySchemas.operationSummary,
        response: {
          200: deliveryResponses.operationSummaryResult,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          429: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    operationSummaryController.handle,
  );

  app.get(
    "/get-delivery/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Detalha uma entrega com itens e ocorrências",
        description:
          "Detalhe completo: destinatário, endereço, itens da carga e `timeline` — tudo o que já aconteceu com esta entrega numa lista só, do mais recente ao mais antigo: chegadas e comprovações do app (com o aparelho que reportou), ocorrências tipadas, mudanças de status feitas na mão (com o motivo do catálogo e a anotação) e as mensagens do chat que citaram esta entrega. A trilha é MONTADA a partir das tabelas que já são donas desses fatos, não copiada para uma tabela própria — dois escritores para um fato é como um fato começa a discordar de si mesmo. Fotos e assinaturas vêm como URLs assinadas de vida curta. O motorista só abre as próprias entregas. Entrega inexistente, de outra empresa ou, para o motorista, de outro motorista → 404 DELIVERY_NOT_FOUND (a mesma resposta nos três casos).",
        params: deliverySchemas.deliveryBusinessParams,
        response: {
          200: deliveryResponses.deliveryDetail,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    getDeliveryController.handle,
  );

  app.patch(
    "/update-delivery/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Edita uma entrega",
        description:
          "Edita destinatário, endereço, embarcador e itens enquanto a entrega está PENDENTE ou com INSUCESSO. A chave e o número da NF-e são definidos uma vez: editáveis enquanto vazios, imutáveis depois (400 DELIVERY_INVOICE_KEY_IMMUTABLE); chave de outra entrega → 409 DELIVERY_INVOICE_KEY_EXISTS. Itens de entrega vinda de XML são os da nota (400 DELIVERY_ITEMS_LOCKED). Trocar para embarcador desativado → 400 SHIPPER_INACTIVE; embarcador inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND. Entrega inexistente ou de outra empresa → 404 DELIVERY_NOT_FOUND (a mesma resposta nos dois casos). Entrega fora de PENDENTE/INSUCESSO → 409 DELIVERY_NOT_EDITABLE. Entrega que mudou de status durante a edição → 409 DELIVERY_STATUS_CONFLICT.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.updateDelivery,
        response: {
          200: deliveryResponses.deliveryUpdated,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    updateDeliveryController.handle,
  );

  app.patch(
    "/update-delivery-status/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Muda o status de uma entrega pelo painel",
        description:
          "Motivo do catálogo obrigatório. Em rota exige motorista (400 DELIVERY_WITHOUT_DRIVER) e rota já iniciada quando a entrega está numa rota planejada ou liberada (400 DELIVERY_ROUTE_NOT_STARTED). Entregue exige `received_by` (quem recebeu, 2 a 150 caracteres, sem espaços nas pontas nem consecutivos). Transições válidas: PENDING→IN_TRANSIT/CANCELLED; IN_TRANSIT→DELIVERED/FAILED/PENDING/CANCELLED; FAILED→PENDING/CANCELLED. DELIVERED grava delivered_at e received_by. A rota acompanha: um desfecho fecha a parada da entrega numa rota em andamento; IN_TRANSIT→PENDING (carga de volta à base) cancela a parada e tira a entrega da rota e da lista do motorista, para que ela possa ir em outra rota; um desfecho final (DELIVERED, FAILED, CANCELLED) de uma entrega cuja parada está numa rota que ainda não saiu tira a parada do plano, enquanto a volta a PENDING ali a mantém no plano. Entrega inexistente ou de outra empresa → 404 DELIVERY_NOT_FOUND; motivo inexistente ou de outra empresa → 404 STATUS_CHANGE_REASON_NOT_FOUND.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.updateDeliveryStatus,
        response: {
          200: deliveryResponses.deliveryStatusUpdated,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.statusConflict,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    updateDeliveryStatusController.handle,
  );

  app.patch(
    "/assign-deliveries/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        // Decision 14.7: the route is the unit of assignment. Kept while an
        // older web image may call it; removed after 14 days without the
        // `assign_deliveries_deprecated_call` log line.
        deprecated: true,
        summary:
          "Atribuir motorista e veículo às entregas, como rota liberada (descontinuado)",
        description:
          'DESCONTINUADO (decisão 14.7): use POST /route/add-stops, POST /route/move-stops ou POST /route/create-route, e libere a rota com PATCH /route/release-route. Cada chamada grava o log `assign_deliveries_deprecated_call`; o endpoint sai depois de 14 dias sem nenhuma. Atalho para "criar uma rota para este motorista com estas paradas e liberá-la". Em lote sobre entregas PENDING, tudo ou nada: uma entrega fora de PENDING, ou motorista/veículo inativo ou de outra empresa, recusa o lote inteiro nomeando os culpados. O veículo é OBRIGATÓRIO — uma rota liberada precisa de um. Atribuir nunca muda o status: uma entrega PENDING com motorista aparece como "Designada", e o motorista a leva a IN_TRANSIT ao iniciar a rota no aplicativo. Reatribuir move os documentos para uma rota nova e libera a parada que eles tinham, o que responde 409 DELIVERY_ON_STARTED_ROUTE depois que a rota anterior saiu; uma rota liberada que fica sem paradas é cancelada (route.cancelled). Uma unidade de trabalho: todas as checagens rodam antes de qualquer escrita, e qualquer recusa deixa a rota anterior exatamente como estava; o status do motorista é relido dentro da transação, com trava compartilhada na linha dele (400 ROUTE_DRIVER_INACTIVE para um motorista inativado no mesmo instante). Reenviar a mesma seleção para o mesmo motorista e veículo responde 200 com a rota já criada e não libera nada duas vezes; se o reenvio trouxer outro plano (dia, destino ou horários), ele é aplicado a essa mesma rota, com as regras da edição de rota. A mensagem diz o que aconteceu: rota criada e liberada, já liberada antes (nada alterado) ou atualizada com o novo planejamento. Devolve a rota para o cliente poder abri-la. O plano da rota vem junto (decisão 6.5): scheduled_date (AAAA-MM-DD; ausente, hoje no fuso da empresa), destination (texto livre, até 160) e planned_departure_at/planned_arrival_at (ISO 8601 COM fuso; saída no dia da rota no fuso da empresa, retorno não anterior à saída nem ao dia da rota — 400 VALIDATION_ERROR ou ROUTE_PLAN_INVALID). Motorista ou veículo de outra empresa responde 404, igual a um que não existe.',
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.assignDeliveries,
        response: {
          200: deliveryResponses.deliveriesAssigned,
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    assignDeliveriesController.handle,
  );

  // -------------------------------------------------------------------
  // Driver surface. Every route below is scoped to the authenticated
  // driver's own deliveries, and every mutation is idempotent by
  // client_submission_id — the app's outbox resends after dead networks.
  // A disabled module answers 403 with code MODULE_NOT_ENABLED, which the
  // app reads to park its queue instead of retrying.
  // -------------------------------------------------------------------

  app.get(
    "/my-deliveries/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista de trabalho do motorista",
        description:
          "Entregas do motorista autenticado: IN_TRANSIT, mais as PENDING de uma rota RELEASED ou IN_PROGRESS (decisão 14.7, D8: rota PLANNED é rascunho que o motorista não vê; `routes` lista as rotas das paradas abertas com o plan_version de cada uma), com embarcador, itens de carga e — quando a entrega está numa rota — a parada aberta com a sequência que o despacho escolheu e a rota a que pertence. Uma resposta só, porque é isso que o app guarda por sete dias offline; um segundo endpoint seria mais uma coisa para ficar velha num celular sem sinal. As linhas vêm pela data, NÃO pela ordem das paradas: o app ordena pela sequência, porque desenha a partir do próprio cache, onde a ordem do servidor já se perdeu. Tipos por categoria (decisão 14.3): `occurrence_types` continua só com os tipos de NÃO ENTREGA ativos (o que o app instalado sabe tratar); `delivered_types` (tipos de ENTREGA, o padrão primeiro) e `pause_types` (tipos de PAUSA com a natureza legal) são do contrato 3. `journey` diz se uma pausa pode começar agora (rota liberada ou em andamento do dia; decisão 14.4). Uma empresa sem os tipos padrão os recebe nesta leitura.",
        params: deliverySchemas.businessIdParam,
        response: {
          200: deliveryResponses.myDeliveries,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    listMyDeliveriesController.handle,
  );

  app.post(
    "/start-route/:businessId",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        // Read leniently by the controller and documented only: a validated
        // body would refuse the bodiless request older builds still send.
        openapi: { body: startDriverRouteSchema, headers: clientSentAtHeaders },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Motorista inicia a rota do dia",
        description:
          "Saída legada, para entregas que NÃO estão numa rota: passa de uma vez todas as entregas avulsas designadas ao motorista autenticado de PENDING para IN_TRANSIT. Nunca inicia uma rota — rota só sai por POST /route/start-route/{routeId}/business/{businessId}, que a nomeia; um motorista com todo o trabalho em rotas recebe started = 0 aqui. Idempotente por natureza: um reenvio não encontra mais nada para mover e responde sucesso com started = 0. O corpo JSON opcional `{ occurred_at }` (o instante do toque, corrigido pelo cabeçalho `X-Client-Sent-At`) limita uma saída enviada com atraso: só se movem as entregas avulsas criadas até o toque, e um toque com mais de 7 dias não move nada (started = 0). Sem ele, todas as entregas avulsas se movem, como antes.",
        params: deliverySchemas.businessIdParam,
        response: {
          200: deliveryResponses.routeStarted,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    startDriverRouteController.handle,
  );

  app.post(
    "/arrival/:deliveryId/business/:businessId",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        // Read by the controller to date an arrival queued offline (MOB-08).
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
        tags: ["delivery"],
        summary: "Motorista registra a chegada ao endereço",
        description:
          "Registra um evento de CHEGADA, com a localização, numa entrega EM ROTA do motorista autenticado. Idempotente por client_submission_id: um reenvio responde sucesso sem gravar um segundo evento. Entrega inexistente, de outra empresa ou de outro motorista: 404 DELIVERY_NOT_FOUND, a mesma resposta nos três casos.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.deliveryArrival,
        response: {
          201: deliveryResponses.arrivalRegistered,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    registerDeliveryArrivalController.handle,
  );

  app.post(
    "/proof/:deliveryId/business/:businessId",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        // Read by the controller to date a proof queued offline (MOB-08).
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
        tags: ["delivery"],
        summary:
          "Motorista comprova a entrega (aplicativo anterior aos tipos de entrega)",
        description:
          'Rota do aplicativo de contrato 2, mantida como adaptador (decisão 14.3): comprovar passou a ser registrar uma ocorrência da categoria entrega, e este corpo é registrado no tipo padrão "Entrega normal" da empresa (o mesmo efeito de `POST /delivery/report-occurrence`: entrega ENTREGUE, evento de COMPROVANTE ligado à ocorrência, parada fechada, aviso ao destinatário, webhooks `proof.registered` e `delivery.delivered`, auditoria e IA do canhoto). O tipo padrão é usado mesmo desativado, porque este aplicativo não tem seletor. A foto do canhoto (e a assinatura na tela, opcional) sobe direto para o armazenamento por PUT pré-assinado; esta rota confere as chaves. Se a empresa passou a exigir no tipo padrão assinatura, fotos ou formulário, responde 400 CLIENT_OUTDATED com `missing` (o aplicativo guarda o comprovante até ser atualizado); se exige autorização da torre, responde 201 com a entrega aguardando a decisão. Idempotente por client_submission_id. Entrega inexistente, de outra empresa ou de outro motorista: 404 DELIVERY_NOT_FOUND, a mesma resposta nos três casos. Cada uso fica no log `legacy_proof_adapter`; a rota sai depois de 14 dias sem uso.',
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.deliveryProof,
        response: {
          201: deliveryResponses.proofRegistered,
          400: deliveryResponses.legacyProofOutdated,
          401: errorResponse,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.statusConflict,
          429: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    registerDeliveryProofController.handle,
  );

  app.post(
    "/report-occurrence/:deliveryId/business/:businessId",
    {
      // Each report can notify every administrator — WhatsApp included, which
      // is paid per message — so a loop of reports is a loop of messages. The
      // driver's other field routes (start, arrival, proof) were limited;
      // this one was not.
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
        // Read by the controller when the body has no client_submission_id;
        // X-Client-Sent-At dates a report queued offline (MOB-08).
        openapi: { headers: idempotencyHeaders.merge(clientSentAtHeaders) },
      },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Registra uma ocorrência na entrega",
        description:
          "Registra uma ocorrência tipada, com descrição, fotos, local e as respostas do formulário do tipo (`form_answers`, validadas contra o formulário atual; decisão 6.2). Todo relato entra no histórico e no feed da torre como evento OCCURRENCE. Tipo impeditivo leva a entrega ativa a Insucesso (FAILED) e fecha a parada. Tipo que exige autorização da torre (decisão 6.3), relatado pelo motorista: a ocorrência fica PENDING e NÃO aplica efeito (nem Insucesso, nem parada, nem webhook) até a torre decidir; os operadores (administradores e usuários com `delivery_manage` de escrita) são avisados e, sem resposta em 10 min, os administradores. Pelo painel, o autor que pode decidir na torre (MASTER, administrador ou `delivery_manage` de escrita) autoriza o próprio relato (APPROVED, efeito na hora); um perfil que só lê entregas registra um pedido PENDING, como o motorista. Um pedido sobre uma tentativa que já terminou (entrega entregue, cancelada ou com insucesso, ou fora das mãos deste motorista) nasce SUPERSEDED. Relato de motorista sem `form_version` (app anterior aos formulários) cujas respostas não atendem o formulário atual → 400 CLIENT_OUTDATED com o formulário. Categorias (decisão 14.3): um tipo DELIVERED registra a ENTREGA — só pelo motorista (painel → 403 DRIVER_ONLY), com `client_submission_id` obrigatório, `receipt_photo`, `signature` e `received_by` conforme as exigências do tipo (faltando → 400 OCCURRENCE_RECEIPT_PHOTO_REQUIRED / OCCURRENCE_SIGNATURE_REQUIRED / OCCURRENCE_PHOTO_REQUIRED) e, sem autorização pendente, o mesmo efeito do comprovante: entrega ENTREGUE, evento PROOF ligado à ocorrência (sem evento OCCURRENCE), parada fechada, aviso ao destinatário, webhooks `proof.registered` e `delivery.delivered` (nunca `occurrence.reported`), cartão de auditoria e IA do canhoto; entrega que não pode mais ser entregue → 400 INVALID_STATUS_TRANSITION. Tipo DELIVERED desativado é aceito quando o toque (`occurred_at`) foi anterior à desativação. Tipo PAUSE → 400 OCCURRENCE_TYPE_WRONG_CATEGORY. Campos que a categoria não usa são descartados. A resposta traz `category` e `delivery_status`. A resposta diz o estado em `data.authorization_status`. Reenviar o mesmo `client_submission_id` devolve a mesma ocorrência (`replayed`). Entrega ou tipo inexistente ou de outra empresa → 404 (DELIVERY_NOT_FOUND / OCCURRENCE_TYPE_NOT_FOUND).",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.reportOccurrence,
        response: {
          201: deliveryResponses.occurrenceReported,
          400: deliveryResponses.occurrenceFormInvalid,
          401: errorResponse,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.occurrenceReportConflict,
          429: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    reportDeliveryOccurrenceController.handle,
  );

  app.get(
    "/occurrence-authorizations",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        // The tower's queue: a driver token never reads it (decision 4.4).
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista as ocorrências aguardando autorização da torre",
        description:
          "A fila da torre (decisão 6.3): os pedidos em tipos que exigem autorização (do motorista, ou do painel por perfil que só lê entregas) ainda sem decisão e cuja tentativa segue viva — um pedido cuja entrega foi entregue, cancelada, teve insucesso, voltou à base ou foi para outra rota ou motorista sai da fila na hora e é encerrado como SUPERSEDED pela varredura de cada minuto —, do mais antigo ao mais novo (no máximo 100; `total` diz quantos há). Cada item traz a entrega, o motorista, as respostas do formulário já rotuladas (`answers`), as fotos em URLs assinadas, `escalates_at` (10 min após o pedido) e `escalated_at` quando já foi escalado aos administradores. O MASTER envia `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED; empresa sem o módulo, 403 MODULE_NOT_ENABLED). Motorista recebe 403 PERMISSION_DENIED; empresa de outra conta, 403 TENANT_ACCESS_DENIED.",
        querystring: deliverySchemas.listPendingAuthorizations,
        response: {
          200: deliveryResponses.pendingAuthorizations,
          400: deliveryResponses.codedError,
          401: errorResponse,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          // The global limit of every route (http.ts).
          429: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    listPendingAuthorizationsController.handle,
  );

  app.post(
    "/occurrence-authorization/:occurrenceId/business/:businessId",
    {
      // A decision notifies the driver (push) and may fail a delivery with
      // its webhooks: never a loop.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Autoriza ou nega uma ocorrência pendente",
        description:
          'A torre decide um relato PENDING (decisão 6.3). `APPROVED` aplica agora o efeito do tipo, como um relato sem autorização: impeditivo leva a entrega a Insucesso (com evento STATUS_CHANGE no instante da aprovação), fecha a parada e dispara `occurrence.reported`/`delivery.failed`. Num pedido de ENTREGA (tipo da categoria DELIVERED, decisão 14.3), `APPROVED` comprova a entrega com o canhoto, a assinatura e o "quem recebeu" do relato, no instante do relato (não no da aprovação): entrega ENTREGUE, evento PROOF ligado à ocorrência, parada fechada, aviso ao destinatário, webhooks `proof.registered` e `delivery.delivered`, auditoria e IA do canhoto; uma entrega que já não pode ser entregue torna o pedido SUPERSEDED. `DENIED` não aplica nada e exige `note` (o motorista lê o motivo). O motorista recebe a decisão em tempo real (`deliveryEvent` na sala do usuário) e por push. Uma decisão por pedido: se outra pessoa decidiu antes, ou a tentativa do pedido terminou de outro jeito (comprovação, mudança de status pelo painel, cancelamento, rota cancelada, entrega em outra rota ou com outro motorista — conferido sob trava da entrega), 409 OCCURRENCE_ALREADY_DECIDED com a decisão que vale (SUPERSEDED nesse caso, sem efeito algum); a mesma pessoa repetindo a mesma decisão recebe 200 com `replayed: true`. Relato que não pede autorização → 409 OCCURRENCE_AUTHORIZATION_NOT_REQUIRED. Ocorrência inexistente ou de outra empresa → 404 OCCURRENCE_NOT_FOUND; entrega da ocorrência não encontrada nesta empresa → 404 DELIVERY_NOT_FOUND. Motorista recebe 403 PERMISSION_DENIED; mais de 60 decisões por minuto → 429.',
        params: deliverySchemas.occurrenceAuthorizationParams,
        body: deliverySchemas.decideOccurrenceAuthorization,
        response: {
          200: deliveryResponses.occurrenceAuthorizationDecided,
          400: deliveryResponses.codedError,
          401: errorResponse,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          409: deliveryResponses.occurrenceAlreadyDecided,
          429: errorResponse,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    decideOccurrenceAuthorizationController.handle,
  );
  app.get(
    "/export-delivery",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      // Write, not read, and deliberately: the whole operation leaving as a
      // file somebody keeps is a heavier act than paging through it on
      // screen, and every other export in the product is gated the same way.
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Exporta as entregas (CSV ou Excel)",
        description:
          "Responde com o arquivo, NÃO com JSON. `format=csv|excel`; `search`, `status`, `shipperId`, `driverId`, `kind` e o período (`period`, `from`, `to`) são os mesmos da listagem, com a mesma exceção da busca exata (o arquivo é o que a tela mostra). A coluna Tipo diz Entrega, Ordem de serviço ou Coleta. O MASTER envia `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED). A data prevista sai só com o dia. O nome do arquivo usa o dia da empresa. O motorista só exporta as próprias entregas — a mesma regra que a tela obedece. As linhas saem do banco em blocos por cursor, não de uma vez: é a única tela em que uma empresa pede a operação inteira, e a diferença entre o cursor e um findMany é a diferença entre um download e uma réplica fora do ar. O status vem em português porque quem lê isso está no Excel.",
        querystring: deliverySchemas.exportDelivery,
        response: {
          200: exportFileResponse("entregas-<AAAA-MM-DD>"),
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    exportDeliveryController.handle,
  );

  app.get(
    "/export-occurrence",
    {
      // A whole company's records as one streamed file: heavy on the
      // database and on memory, and never needed ten times a minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      // Write, not read, for the same reason the delivery export is: a file
      // with every occurrence in the operation leaves the building and is
      // kept, and every other export in the product is gated this way.
      preHandler: [
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Exporta as ocorrências (CSV ou Excel)",
        description:
          "Responde com o arquivo, NÃO com JSON. `search` (ID da ocorrência, ID da entrega, destinatário, tipo), `severity`, `occurrenceTypeId` e `deliveryStatus` são os mesmos da listagem de ocorrências. O MASTER envia `businessId` (sem ele, 400 BUSINESS_NOT_IDENTIFIED). O relatório que a transportadora manda ao embarcador quando ele pergunta por que a carga não entrou: uma linha por ocorrência, com o tipo, se ele barra a entrega, o destinatário e quem reportou. Mesmo streaming por cursor da exportação de entregas.",
        querystring: deliverySchemas.exportOccurrence,
        response: {
          200: exportFileResponse("ocorrencias-<AAAA-MM-DD>"),
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    exportOccurrenceController.handle,
  );
  app.get(
    "/proof-document/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],

      // A render is real CPU work (on the render worker, not this thread),
      // and `regenerate=true` repeats it on demand: one client looping on it
      // would keep the replica's render queue full for everybody else.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Comprovante da entrega (PDF), gerado no primeiro pedido",
        description:
          "Responde com um LINK para o PDF e o hash dele, não com os bytes. O documento é gerado na primeira vez que alguém pede: a imensa maioria das entregas nunca tem o comprovante aberto, e renderizar cinco milhões de PDFs por mês para que dois por cento sejam lidos é trabalho que ninguém pediu — e que ficaria no caminho da comprovação do motorista, num caminhão, em 3G. Só existe depois que a entrega termina; pedir de uma entrega em andamento responde 409. `regenerate=true` refaz o arquivo mantendo o mesmo token de verificação, para que um QR já impresso continue chegando à página; a versão é o que diz que aquela cópia não é a atual.",
        params: proofDocumentSchemas.proofDocumentParams,
        querystring: proofDocumentSchemas.proofDocumentQuery,
        response: {
          200: proofDocumentResponses.proofDocument,
          // The refusals carry `code` (decision 11.3): what the error
          // handler really sends, not the bare `{ message }`.
          400: proofDocumentResponses.proofDocumentError,
          401: errorResponse.describe(
            "Sem sessão válida (token ausente, expirado ou revogado).",
          ),
          403: proofDocumentResponses.proofDocumentError,
          404: proofDocumentResponses.proofDocumentError,
          409: proofDocumentResponses.proofDocumentError,
          429: errorResponse,
          500: proofDocumentResponses.internalServerError,
          503: errorResponse.describe(
            "A fila de geração está cheia ou a geração passou do tempo (PROOF_RENDER_BUSY, PROOF_RENDER_TIMEOUT, PROOF_RENDER_UNAVAILABLE), ou a assinatura ICP-Brasil falhou com o certificado válido (PROOF_SIGNING_FAILED; nada foi gravado), ou o armazenamento de arquivos não respondeu ao ler a foto ou a assinatura, ou ao gravar o PDF (STORAGE_UNAVAILABLE; nada foi gravado); tente de novo em instantes.",
          ),
        },
      },
    },
    getProofDocumentController.handle,
  );
  app.get(
    "/message-templates",
    {
      onRequest: [ensureAuthenticated],
      // What the company writes to its customers is the office's, not the
      // driver's (decision 4.4).
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista as mensagens ao cliente da empresa",
        description:
          "Responde em JSON comum, não em NDJSON: são no máximo oito (quatro momentos — saiu para entrega, a caminho, entregue, não entregue — × dois canais), e um stream sobre oito linhas é maquinário em volta de uma lista que cabe numa tela. Token de motorista recebe 403 PERMISSION_DENIED.",
        querystring: proofDocumentSchemas.listMessageTemplates,
        response: {
          200: proofDocumentResponses.messageTemplateList,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    listMessageTemplatesController.handle,
  );

  app.put(
    "/message-template/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Salva a mensagem ao cliente de um momento e canal",
        description:
          "PUT e não POST: existe no máximo uma mensagem por empresa × momento × canal, e uma segunda faria a frase que sai depender da ordem das linhas. Variável desconhecida (ex.: {{ gabriel }}) é recusada pelo schema com 400 VALIDATION_ERROR e a lista das disponíveis; corpo só de espaços também. Emite `catalogChanged` (message_template). As variáveis são validadas AQUI, no salvamento, que é o único momento em que validá-las serve para alguma coisa — quem digitou {{motorista}} precisa descobrir no formulário, não pelo cliente recebendo uma mensagem com um vazio dias depois. Uma mensagem de WhatsApp sem {{link_descadastro}} é recusada: mensagem sem saída é denúncia de spam, e quem escreveu não é quem a Meta suspende primeiro. Sem mensagem cadastrada, NADA é enviado naquele momento — quem não escreveu não quer uma enviada em seu nome.",
        params: proofDocumentSchemas.proofDocumentParams.pick({
          businessId: true,
        }),
        body: proofDocumentSchemas.saveMessageTemplate,
        response: {
          200: proofDocumentResponses.messageTemplateSaved,
          400: deliveryResponses.codedError,
          403: deliveryResponses.codedError,
          404: deliveryResponses.codedError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    saveMessageTemplateController.handle,
  );
  app.get(
    "/proof-audits",
    {
      onRequest: [ensureAuthenticated],
      // The audit queue is the office's (decision 4.4): a driver token is
      // refused by the guard with PERMISSION_DENIED (decision 4.1).
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Lista a fila de auditoria de comprovantes",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` e cada linha seguinte é um card. Na fila: prioridade da leitura (sem leitura primeiro, depois as menos confiantes), depois a mais antiga; Aprovados/Rejeitados: a decisão mais recente primeiro; paginação por offset no servidor. `searchMeta.agreementRate` é a taxa de concordância entre a máquina e a pessoa e cobre os últimos `agreementWindowDays` dias.",
        querystring: proofAuditSchemas.listProofAudits,
        response: {
          200: ndjsonList(
            proofAuditResponses.auditQueueCard,
            proofAuditResponses.auditQueueEnvelope.shape.meta,
          ),
          400: proofAuditResponses.genericError,
          403: proofAuditResponses.genericError,
          404: proofAuditResponses.genericError,
          500: proofAuditResponses.internalServerError,
        },
      },
    },
    listProofAuditsController.handle,
  );

  app.patch(
    "/proof-audit/:auditId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Registra o veredito de uma pessoa sobre um comprovante",
        description:
          "A metade que a máquina não faz. A auditoria registrou o motivo: um veredito de IA sem ninguém atrás não fecha o ciclo probatório, e uma entrega cujo comprovante nunca foi olhado por uma pessoa é uma entrega cujo comprovante não se sustenta quando for contestado. Rejeitar exige motivo (400 REJECTION_REASON_REQUIRED sem ele; 400 INVALID_REJECTION_REASON fora das regras de texto), e o motivo não é burocracia: é o que o despachante lê para decidir se a carga volta à rua e o que o embarcador vê quando pergunta por que um canhoto foi recusado. Uma rejeição registra uma ocorrência 'Comprovante rejeitado' — que NÃO é impeditiva: se a entrega volta à rua é decisão do despachante, que pode ter uma confirmação verbal que a foto não mostra. Dois revisores no mesmo card: o segundo recebe 409.",
        params: proofAuditSchemas.reviewProofAuditParams,
        body: proofAuditSchemas.reviewProofAudit,
        response: {
          200: proofAuditResponses.auditReviewed,
          400: proofAuditResponses.genericError,
          403: proofAuditResponses.genericError,
          404: proofAuditResponses.genericError,
          409: proofAuditResponses.genericError,
          500: proofAuditResponses.internalServerError,
        },
      },
    },
    reviewProofAuditController.handle,
  );
}

export { deliveryRoutes };
