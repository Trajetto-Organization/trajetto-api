import { FastifyInstance } from "fastify";

import { CreateDeliveryController } from "@/modules/delivery/usecases/create-delivery/create-delivery-controller";
import { ListDeliveryController } from "@/modules/delivery/usecases/list-delivery/list-delivery-controller";

import { ListOccurrencesController } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-controller";
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
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Create a delivery (manual entry)",
        description:
          "Register a delivery manually with recipient, address, optional NFe key (44 digits, dedupe anchor) and cargo items.",
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.createDelivery,
        response: {
          201: deliveryResponses.deliveryCreated,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Import deliveries from NF-e XML files",
        description:
          "Each XML becomes a delivery. Files are processed independently and reported one by one: a malformed file never sinks the batch. Re-importing the same note is a no-op (dedupe by access key). The NF-e issuer becomes the shipper — matched by CNPJ, created when unknown — unless shipperId forces one.",
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.importDeliveryXml,
        response: {
          200: deliveryResponses.deliveriesImported,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
        summary: "List deliveries",
        description:
          "Paginated list with filters by status, shipper and driver, plus free search (recipient, order code, NFe key, city, driver name or CNH). Driver users only see their own deliveries.",
        querystring: deliverySchemas.listDeliveries,
        response: {
          200: deliveryResponses.deliveryList,
          400: deliveryResponses.genericError,
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
        summary: "Cross-delivery occurrence feed",
        description:
          "Every occurrence of the operation in one paginated table — type (with blocking flag), delivery, reporter and signed photo URLs. Filters by blocking, type and free search (occurrence id, delivery id, recipient or type name). Driver users only see occurrences of their own deliveries.",
        querystring: deliverySchemas.listOccurrences,
        response: {
          200: deliveryResponses.occurrenceList,
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
        summary: "Monitoring panel aggregates",
        description:
          "Totals of the day (unassigned, designated, in route, delivered today, failed today, occurrences today) plus the per-driver board, busiest first. 'Today' is the server's midnight. Manager surface: driver tokens are refused.",
        querystring: deliverySchemas.operationSummary,
        response: {
          200: deliveryResponses.operationSummaryResult,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
        summary: "Get a delivery with items and occurrences",
        description:
          "Full detail: recipient, address, cargo items, and `timeline` — everything that ever happened to this delivery in one list, newest first: chegadas e comprovações do app (com o aparelho que reportou), ocorrências tipadas, mudanças de status feitas na mão (com o motivo do catálogo e a anotação) e as mensagens do chat que citaram esta entrega. A trilha é MONTADA a partir das tabelas que já são donas desses fatos, não copiada para uma tabela própria — dois escritores para um fato é como um fato começa a discordar de si mesmo. Fotos e assinaturas vêm como URLs assinadas de vida curta. Driver users only open their own deliveries.",
        params: deliverySchemas.deliveryBusinessParams,
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
        summary: "Update a delivery",
        description:
          "Edit recipient/address/assignment while the delivery is PENDING or FAILED. Items and NFe key are frozen after creation.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.updateDelivery,
        response: {
          200: deliveryResponses.deliveryUpdated,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
        summary: "Move a delivery through the status machine",
        description:
          "Legal transitions: PENDING→IN_TRANSIT/CANCELLED; IN_TRANSIT→DELIVERED/FAILED/PENDING/CANCELLED; FAILED→PENDING/CANCELLED. DELIVERED stamps delivered_at and received_by.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.updateDeliveryStatus,
        response: {
          200: deliveryResponses.deliveryStatusUpdated,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
        summary: "Assign a driver (and optionally a vehicle) to deliveries",
        description:
          "Batch assignment over PENDING deliveries, all-or-nothing: a delivery outside PENDING, or a driver/vehicle inactive or from another business, rejects the whole batch naming the offenders. Assigning never changes status — a PENDING delivery with a driver reads as 'Designada'; the driver moves it to IN_TRANSIT by starting the route in the app.",
        params: deliverySchemas.businessIdParam,
        body: deliverySchemas.assignDeliveries,
        response: {
          200: deliveryResponses.deliveriesAssigned,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          409: deliveryResponses.genericError,
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
        summary: "Driver's working list",
        description:
          "Deliveries of the authenticated driver (PENDING = designated, plus IN_TRANSIT) with shipper, cargo items and — when the delivery is on a route — its open stop carrying the sequence the dispatcher chose and the route it belongs to. One payload, because this is what the app caches for seven days offline; a second endpoint would be a second thing to go stale on a phone with no signal. Rows come back dated-first, NOT in stop order: the app sorts by sequence, since it renders from its own cache where the server's order is long gone.",
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
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Driver starts the day's route",
        description:
          "Moves every delivery designated to the authenticated driver from PENDING to IN_TRANSIT in one batch — the load leaves as a block. Naturally idempotent: a resend finds nothing left to move and succeeds with started = 0.",
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
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Driver arrived at the address",
        description:
          "Records an ARRIVAL event with geolocation on an IN_TRANSIT delivery of the authenticated driver. Idempotent by client_submission_id: a resend returns success without a second event.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.deliveryArrival,
        response: {
          201: deliveryResponses.arrivalRegistered,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    registerDeliveryArrivalController.handle,
  );

  app.post(
    "/proof/:deliveryId/business/:businessId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Driver proves the delivery",
        description:
          "Receipt photo (and optional on-screen signature) uploaded straight to storage via presigned PUT; this endpoint validates the keys, records the PROOF event and moves the delivery to DELIVERED in one transaction. Idempotent by client_submission_id.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.deliveryProof,
        response: {
          201: deliveryResponses.proofRegistered,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    registerDeliveryProofController.handle,
  );

  app.post(
    "/report-occurrence/:deliveryId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "Report an occurrence on a delivery",
        description:
          "Records a typed occurrence with optional description and geolocation. Blocking types flip the active delivery to FAILED.",
        params: deliverySchemas.deliveryBusinessParams,
        body: deliverySchemas.reportOccurrence,
        response: {
          201: deliveryResponses.occurrenceReported,
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    reportDeliveryOccurrenceController.handle,
  );
  app.get(
    "/export-delivery",
    {
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
        summary: "Export deliveries (CSV or Excel)",
        description:
          "Responde com o arquivo, NÃO com JSON. `format=csv|excel`, `search` e `status` filtram igual à listagem, e o motorista só exporta as próprias entregas — a mesma regra que a tela obedece. As linhas saem do banco em blocos por cursor, não de uma vez: é a única tela em que uma empresa pede a operação inteira, e a diferença entre o cursor e um findMany é a diferença entre um download e uma réplica fora do ar. O status vem em português porque quem lê isso está no Excel.",
        querystring: deliverySchemas.exportDelivery,
        response: {
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
          500: deliveryResponses.internalServerError,
        },
      },
    },
    exportDeliveryController.handle,
  );

  app.get(
    "/export-occurrence",
    {
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
        summary: "Export occurrences (CSV or Excel)",
        description:
          "Responde com o arquivo, NÃO com JSON. O relatório que a transportadora manda ao embarcador quando ele pergunta por que a carga não entrou: uma linha por ocorrência, com o tipo, se ele barra a entrega, o destinatário e quem reportou. Mesmo streaming por cursor da exportação de entregas.",
        querystring: deliverySchemas.exportDelivery,
        response: {
          400: deliveryResponses.genericError,
          403: deliveryResponses.genericError,
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
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "The delivery receipt (PDF), generated on first request",
        description:
          "Responde com um LINK para o PDF e o hash dele, não com os bytes. O documento é gerado na primeira vez que alguém pede: a imensa maioria das entregas nunca tem o comprovante aberto, e renderizar cinco milhões de PDFs por mês para que dois por cento sejam lidos é trabalho que ninguém pediu — e que ficaria no caminho da comprovação do motorista, num caminhão, em 3G. Só existe depois que a entrega termina; pedir de uma entrega em andamento responde 409. `regenerate=true` refaz o arquivo mantendo o mesmo token de verificação, para que um QR já impresso continue chegando à página; a versão é o que diz que aquela cópia não é a atual.",
        params: proofDocumentSchemas.proofDocumentParams,
        querystring: proofDocumentSchemas.proofDocumentQuery,
        response: {
          200: proofDocumentResponses.proofDocument,
          400: proofDocumentResponses.genericError,
          403: proofDocumentResponses.genericError,
          404: proofDocumentResponses.genericError,
          409: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    getProofDocumentController.handle,
  );
  app.get(
    "/message-templates",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "The messages this company sends to its customers",
        description:
          "Responde em JSON comum, não em NDJSON: são no máximo seis (três momentos × dois canais), e um stream sobre seis linhas é maquinário em volta de uma lista que cabe numa tela.",
        querystring: proofDocumentSchemas.listMessageTemplates,
        response: {
          200: proofDocumentResponses.messageTemplateList,
          400: proofDocumentResponses.genericError,
          403: proofDocumentResponses.genericError,
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
        summary: "Write what this company says at one moment, on one channel",
        description:
          "PUT e não POST: existe no máximo uma mensagem por empresa × momento × canal, e uma segunda faria a frase que sai depender da ordem das linhas. As variáveis são validadas AQUI, no salvamento, que é o único momento em que validá-las serve para alguma coisa — quem digitou {{motorista}} precisa descobrir no formulário, não pelo cliente recebendo uma mensagem com um vazio dias depois. Uma mensagem de WhatsApp sem {{link_descadastro}} é recusada: mensagem sem saída é denúncia de spam, e quem escreveu não é quem a Meta suspende primeiro. Sem mensagem cadastrada, NADA é enviado naquele momento — quem não escreveu não quer uma enviada em seu nome.",
        params: proofDocumentSchemas.proofDocumentParams.pick({
          businessId: true,
        }),
        body: proofDocumentSchemas.saveMessageTemplate,
        response: {
          200: proofDocumentResponses.messageTemplateSaved,
          400: proofDocumentResponses.genericError,
          403: proofDocumentResponses.genericError,
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
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "The receipts waiting for a person to look at them",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` e cada linha seguinte é um card. A ordem é a que faz uma pessoa render: primeiro a foto que a máquina não conseguiu ler, depois as leituras de que ela menos se convenceu, e por último as limpas e confiantes que um revisor libera num segundo. `searchMeta.agreementRate` é a taxa de concordância entre a máquina e a pessoa — o único número que responde se a IA vale o que custa.",
        querystring: proofAuditSchemas.listProofAudits,
        response: {
          200: proofAuditResponses.auditQueueEnvelope,
          400: proofAuditResponses.genericError,
          403: proofAuditResponses.genericError,
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
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["delivery"],
        summary: "A person's verdict on a receipt",
        description:
          "A metade que a máquina não faz. A auditoria registrou o motivo: um veredito de IA sem ninguém atrás não fecha o ciclo probatório, e uma entrega cujo comprovante nunca foi olhado por uma pessoa é uma entrega cujo comprovante não se sustenta quando for contestado. Rejeitar exige motivo, e o motivo não é burocracia: é o que o despachante lê para decidir se a carga volta à rua e o que o embarcador vê quando pergunta por que um canhoto foi recusado. Uma rejeição registra uma ocorrência 'Comprovante rejeitado' — que NÃO é impeditiva: se a entrega volta à rua é decisão do despachante, que pode ter uma confirmação verbal que a foto não mostra. Dois revisores no mesmo card: o segundo recebe 409.",
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
