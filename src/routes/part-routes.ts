import { FastifyInstance } from "fastify";

import { CreatePartController } from "@/modules/part/usecases/create-part/create-part-controller";
import { ListPartController } from "@/modules/part/usecases/list-part/list-part-controller";

import { SearchPartCursorController } from "@/modules/part/usecases/search-part-cursor/search-part-cursor-controller";

import { UpdatePartController } from "@/modules/part/usecases/update-part/update-part-controller";
import { DeletePartController } from "@/modules/part/usecases/delete-part/delete-part-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { partSchemas, partResponses } from "./documentation/part-documentation";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

const createPartController = new CreatePartController();
const listPartController = new ListPartController();

const searchPartCursorController = new SearchPartCursorController();

const updatePartController = new UpdatePartController();
const deletePartController = new DeletePartController();

async function partRoutes(app: FastifyInstance) {
  app.post(
    "/create-part/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Create a new part",
        description:
          "Register a new vehicle part or component in the inventory system with specifications and pricing",
        params: partSchemas.businessIdParam,
        body: partSchemas.createPart,
        response: {
          201: partResponses.partCreated,
          400: partResponses.createPartErrors,
          403: partResponses.createPartForbiddenErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    createPartController.handle,
  );

  app.get(
    "/list-part",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "List parts",
        description:
          "Retrieve a paginated list of vehicle parts and components with optional search and filtering",
        querystring: partSchemas.listPart,
        response: {
          200: partResponses.partList,
          400: partResponses.listPartErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    listPartController.handle,
  );

  app.get(
    "/search-part-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Search parts by business (cursor-based)",
        description:
          "Retrieve parts as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual part objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: partSchemas.searchPartCursor,
        response: {
          200: partResponses.searchPartStreamDescription,
          400: partResponses.partBusinessErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    searchPartCursorController.handle,
  );

  app.patch(
    "/update-part/:partId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("part_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Update a part",
        description:
          "Update existing vehicle part information including specifications, pricing, and inventory details",
        params: partSchemas.partBusinessParams,
        body: partSchemas.updatePart,
        response: {
          200: partResponses.partUpdated,
          400: partResponses.updatePartErrors,
          403: partResponses.updatePartForbiddenErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    updatePartController.handle,
  );

  app.delete(
    "/delete-part/:partId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        summary: "Delete a part",
        description:
          "Permanently remove a vehicle part or component from the inventory system",
        params: partSchemas.partBusinessParams,
        response: {
          200: partResponses.partDeleted,
          400: partResponses.deletePartErrors,
          403: partResponses.deletePartForbiddenErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    deletePartController.handle,
  );
}

export { partRoutes };
