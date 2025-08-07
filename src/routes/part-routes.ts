import { FastifyInstance } from "fastify";

import { CreatePartController } from "@/modules/part/usecases/create-part/create-part-controller";
import { ListPartController } from "@/modules/part/usecases/list-part/list-part-controller";

import { ListPartBusinessController } from "@/modules/part/usecases/list-part-business/list-part-business-controller";

import { UpdatePartController } from "@/modules/part/usecases/update-part/update-part-controller";
import { DeletePartController } from "@/modules/part/usecases/delete-part/delete-part-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { partSchemas, partResponses } from "./documentation/part-documentation";

const createPartController = new CreatePartController();
const listPartController = new ListPartController();

const listPartBusinessController = new ListPartBusinessController();

const updatePartController = new UpdatePartController();
const deletePartController = new DeletePartController();

async function partRoutes(app: FastifyInstance) {
  app.post(
    "/create-part/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        description: "Create a new part",
        params: partSchemas.businessIdParam,
        body: partSchemas.createPart,
        response: {
          201: partResponses.partCreated,
          400: partResponses.createPartErrors,
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
        description: "List parts",
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
    "/list-part-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        description: "List part business",
        querystring: partSchemas.listPartBusinessSchema,
        response: {
          200: partResponses.partList,
          400: partResponses.partBusinessErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    listPartBusinessController.handle,
  );

  app.patch(
    "/update-part/:partId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["part"],
        description: "Update part information",
        params: partSchemas.partBusinessParams,
        body: partSchemas.updatePart,
        response: {
          200: partResponses.partUpdated,
          400: partResponses.updatePartErrors,
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
        description: "Delete a part",
        params: partSchemas.partBusinessParams,
        response: {
          200: partResponses.partDeleted,
          400: partResponses.deletePartErrors,
          500: partResponses.internalServerError,
        },
      },
    },
    deletePartController.handle,
  );
}

export { partRoutes };
