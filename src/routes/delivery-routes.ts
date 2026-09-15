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

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  deliverySchemas,
  deliveryResponses,
} from "./documentation/delivery-documentation";

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
}

export { deliveryRoutes };
