import { FastifyInstance } from "fastify";

import { CreateShipperController } from "@/modules/shipper/usecases/create-shipper/create-shipper-controller";
import { ListShipperController } from "@/modules/shipper/usecases/list-shipper/list-shipper-controller";

import { SearchShipperCursorController } from "@/modules/shipper/usecases/search-shipper-cursor/search-shipper-cursor-controller";
import { UpdateShipperController } from "@/modules/shipper/usecases/update-shipper/update-shipper-controller";
import { DeleteShipperController } from "@/modules/shipper/usecases/delete-shipper/delete-shipper-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  shipperSchemas,
  shipperResponses,
} from "./documentation/shipper-documentation";

const createShipperController = new CreateShipperController();
const listShipperController = new ListShipperController();

const searchShipperCursorController = new SearchShipperCursorController();
const updateShipperController = new UpdateShipperController();
const deleteShipperController = new DeleteShipperController();

// Every route lives behind the DELIVERIES entitlement — the first consumer
// of verifyModuleEnabled. Companies without the module get a 403.
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function shipperRoutes(app: FastifyInstance) {
  app.post(
    "/create-shipper/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Create a new shipper (embarcador)",
        description:
          "Register a cargo owner the carrier delivers for. Shippers are a dimension inside the tenant (multi-shipper support).",
        params: shipperSchemas.businessIdParam,
        body: shipperSchemas.createShipper,
        response: {
          201: shipperResponses.shipperCreated,
          400: shipperResponses.genericError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    createShipperController.handle,
  );

  app.get(
    "/list-shipper",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "List shippers",
        description:
          "Paginated list of the company's shippers with optional search by name, CNPJ or email.",
        querystring: shipperSchemas.listShippers,
        response: {
          200: shipperResponses.shipperList,
          400: shipperResponses.genericError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    listShipperController.handle,
  );

  app.get(
    "/search-shipper-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Search shippers by business (cursor-based)",
        description:
          "Active shippers as an NDJSON stream with cursor pagination, for the infinite-scroll select used when creating a delivery. " +
          "First line carries {meta: {searchMeta: {nextCursor, hasMore}}}; the following lines are shippers.",
        querystring: shipperSchemas.searchShipperCursor,
        response: {
          200: shipperResponses.searchShipperStreamDescription,
          400: shipperResponses.genericError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    searchShipperCursorController.handle,
  );

  app.patch(
    "/update-shipper/:shipperId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Update a shipper",
        description:
          "Update shipper data or toggle is_active. Deactivated shippers keep their delivery history but leave new-delivery dropdowns.",
        params: shipperSchemas.shipperBusinessParams,
        body: shipperSchemas.updateShipper,
        response: {
          200: shipperResponses.shipperUpdated,
          400: shipperResponses.genericError,
          403: shipperResponses.genericError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    updateShipperController.handle,
  );

  app.delete(
    "/delete-shipper/:shipperId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["shipper"],
        summary: "Delete a shipper",
        description:
          "Remove a shipper without deliveries. Shippers with deliveries must be deactivated instead (history preservation).",
        params: shipperSchemas.shipperBusinessParams,
        response: {
          200: shipperResponses.shipperDeleted,
          400: shipperResponses.genericError,
          403: shipperResponses.genericError,
          500: shipperResponses.internalServerError,
        },
      },
    },
    deleteShipperController.handle,
  );
}

export { shipperRoutes };
