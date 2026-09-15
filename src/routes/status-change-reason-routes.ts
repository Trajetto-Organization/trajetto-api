import { FastifyInstance } from "fastify";

import { CreateStatusChangeReasonController } from "@/modules/status-change-reason/usecases/create-status-change-reason/create-status-change-reason-controller";
import { ListStatusChangeReasonController } from "@/modules/status-change-reason/usecases/list-status-change-reason/list-status-change-reason-controller";

import { UpdateStatusChangeReasonController } from "@/modules/status-change-reason/usecases/update-status-change-reason/update-status-change-reason-controller";
import { DeleteStatusChangeReasonController } from "@/modules/status-change-reason/usecases/delete-status-change-reason/delete-status-change-reason-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  statusChangeReasonSchemas,
  statusChangeReasonResponses,
} from "./documentation/status-change-reason-documentation";

const createStatusChangeReasonController =
  new CreateStatusChangeReasonController();
const listStatusChangeReasonController = new ListStatusChangeReasonController();

const updateStatusChangeReasonController =
  new UpdateStatusChangeReasonController();
const deleteStatusChangeReasonController =
  new DeleteStatusChangeReasonController();

/**
 * The company's vocabulary for overriding a delivery's status.
 *
 * Behind `delivery_manage` and the DELIVERIES module, like the deliveries it
 * explains: this catalogue exists only to answer a question about a delivery,
 * and a company without the module has no delivery to answer about.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function statusChangeReasonRoutes(app: FastifyInstance) {
  app.post(
    "/create-status-change-reason/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["statusChangeReason"],
        summary: "Add a reason to the status-override catalogue",
        description:
          "The words the company uses to explain why a delivery's status was moved by hand. Short on purpose — this appears in a picker and in a timeline row, and a sentence there is a sentence nobody can group or count; the detail belongs in the note the operator types at the moment of the change. Names are unique per company.",
        params: statusChangeReasonSchemas.businessIdParam,
        body: statusChangeReasonSchemas.createStatusChangeReason,
        response: {
          201: statusChangeReasonResponses.reasonCreated,
          400: statusChangeReasonResponses.genericError,
          403: statusChangeReasonResponses.genericError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    createStatusChangeReasonController.handle,
  );

  app.get(
    "/list-status-change-reason",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["statusChangeReason"],
        summary: "List the status-override catalogue",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` e cada linha seguinte é um motivo. Chamar response.json() nisso dá erro de parse — leia linha a linha. `searchMeta.used` conta quantos motivos já explicam alguma mudança no histórico, que é o que separa o vocabulário real do que foi digitado uma vez e esquecido.",
        querystring: statusChangeReasonSchemas.listStatusChangeReasons,
        response: {
          200: statusChangeReasonResponses.reasonListEnvelope,
          400: statusChangeReasonResponses.genericError,
          403: statusChangeReasonResponses.genericError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    listStatusChangeReasonController.handle,
  );

  app.patch(
    "/update-status-change-reason/:reasonId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["statusChangeReason"],
        summary: "Edit or retire a reason",
        description:
          "`is_active: false` retires a reason: it keeps explaining the events that already cite it and stops being offered for new changes. That is how a reason leaves the vocabulary — deleting one that has been used is refused outright, because the trail would stop naming a decision somebody made.",
        params: statusChangeReasonSchemas.reasonBusinessParams,
        body: statusChangeReasonSchemas.updateStatusChangeReason,
        response: {
          200: statusChangeReasonResponses.reasonUpdated,
          400: statusChangeReasonResponses.genericError,
          403: statusChangeReasonResponses.genericError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    updateStatusChangeReasonController.handle,
  );

  app.delete(
    "/delete-status-change-reason/:reasonId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["statusChangeReason"],
        summary: "Remove a reason nobody ever used",
        description:
          "Only a word the catalogue never spent. A reason already cited by an event is part of the answer support gives about a decision somebody made, so removing it answers 409 naming how many events depend on it — and points at retiring it instead. The foreign key refuses too; this exists so the refusal is a sentence rather than a 500.",
        params: statusChangeReasonSchemas.reasonBusinessParams,
        response: {
          200: statusChangeReasonResponses.reasonDeleted,
          400: statusChangeReasonResponses.genericError,
          403: statusChangeReasonResponses.genericError,
          409: statusChangeReasonResponses.genericError,
          500: statusChangeReasonResponses.internalServerError,
        },
      },
    },
    deleteStatusChangeReasonController.handle,
  );
}

export { statusChangeReasonRoutes };
