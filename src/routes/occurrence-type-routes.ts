import { FastifyInstance } from "fastify";

import { CreateOccurrenceTypeController } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-controller";
import { ListOccurrenceTypeController } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-controller";

import { UpdateOccurrenceTypeController } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-controller";
import { DeleteOccurrenceTypeController } from "@/modules/occurrence-type/usecases/delete-occurrence-type/delete-occurrence-type-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  occurrenceTypeSchemas,
  occurrenceTypeResponses,
} from "./documentation/occurrence-type-documentation";

const createOccurrenceTypeController = new CreateOccurrenceTypeController();
const listOccurrenceTypeController = new ListOccurrenceTypeController();

const updateOccurrenceTypeController = new UpdateOccurrenceTypeController();
const deleteOccurrenceTypeController = new DeleteOccurrenceTypeController();

const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function occurrenceTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-occurrence-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrenceType"],
        summary: "Create a delivery occurrence type",
        description:
          "Add an entry to the company's occurrence catalog. blocks_delivery marks impeditive types: reporting one flips the active delivery to FAILED.",
        params: occurrenceTypeSchemas.businessIdParam,
        body: occurrenceTypeSchemas.createOccurrenceType,
        response: {
          201: occurrenceTypeResponses.occurrenceTypeCreated,
          400: occurrenceTypeResponses.genericError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    createOccurrenceTypeController.handle,
  );

  app.get(
    "/list-occurrence-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("occurrence_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrenceType"],
        summary: "List delivery occurrence types",
        description:
          "Paginated list of the company's occurrence catalog with optional search.",
        querystring: occurrenceTypeSchemas.listOccurrenceTypes,
        response: {
          200: occurrenceTypeResponses.occurrenceTypeList,
          400: occurrenceTypeResponses.genericError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    listOccurrenceTypeController.handle,
  );

  app.patch(
    "/update-occurrence-type/:occurrenceTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrenceType"],
        summary: "Update a delivery occurrence type",
        description:
          "Update the catalog entry or toggle is_active. Deactivated types keep their history but leave new-occurrence dropdowns.",
        params: occurrenceTypeSchemas.occurrenceTypeBusinessParams,
        body: occurrenceTypeSchemas.updateOccurrenceType,
        response: {
          200: occurrenceTypeResponses.occurrenceTypeUpdated,
          400: occurrenceTypeResponses.genericError,
          403: occurrenceTypeResponses.genericError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    updateOccurrenceTypeController.handle,
  );

  app.delete(
    "/delete-occurrence-type/:occurrenceTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrenceType"],
        summary: "Delete a delivery occurrence type",
        description:
          "Remove an unused catalog entry. Types already referenced by occurrences must be deactivated instead.",
        params: occurrenceTypeSchemas.occurrenceTypeBusinessParams,
        response: {
          200: occurrenceTypeResponses.occurrenceTypeDeleted,
          400: occurrenceTypeResponses.genericError,
          403: occurrenceTypeResponses.genericError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    deleteOccurrenceTypeController.handle,
  );
}

export { occurrenceTypeRoutes };
