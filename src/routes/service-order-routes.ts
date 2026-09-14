import { FastifyInstance } from "fastify";

import { CreateServiceOrderController } from "@/modules/service-order/usecases/create-service-order/create-service-order-controller";
import { ListServiceOrderController } from "@/modules/service-order//usecases/list-service-order/list-service-order-controller";

import { UpdateServiceOrderController } from "@/modules/service-order//usecases/update-service-order/update-service-order-controller";
import { DeleteServiceOrderController } from "@/modules/service-order//usecases/delete-service-order/delete-service-order-controller";

import { SearchServiceOrderCursorController } from "@/modules/service-order/usecases/search-service-order-cursor/search-service-order-cursor-controller";
import { SearchServiceOrderByVehicleCursorController } from "@/modules/service-order/usecases/search-service-order-by-vehicle-cursor/search-service-order-by-vehicle-cursor-controller";

import { ExportServiceOrderController } from "@/modules/service-order/usecases/export-service-order/export-service-order-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  verifyBranchActive,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import {
  serviceOrderSchemas,
  serviceOrderResponses,
} from "./documentation/service-order-documentation";

const createServiceOrderController = new CreateServiceOrderController();
const listServiceOrderController = new ListServiceOrderController();

const searchServiceOrderCursorController =
  new SearchServiceOrderCursorController();
const searchServiceOrderByVehicleCursorController =
  new SearchServiceOrderByVehicleCursorController();

const exportServiceOrderController = new ExportServiceOrderController();

const updateServiceOrderController = new UpdateServiceOrderController();
const deleteServiceOrderController = new DeleteServiceOrderController();

async function serviceOrderRoutes(app: FastifyInstance) {
  // Fleet operation: gated by the FLEET module for the whole plugin (runs
  // after ensureAuthenticated, which is onRequest). MASTER bypasses.
  app.addHook("preHandler", verifyModuleEnabled("FLEET"));

  app.post(
    "/create-service-order/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("service_order_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Create a new service order",
        description:
          "Register a new vehicle maintenance or repair service order with parts, labor, and scheduling details",
        params: serviceOrderSchemas.businessIdParam,
        body: serviceOrderSchemas.createServiceOrder,
        response: {
          201: serviceOrderResponses.serviceOrderCreated,
          400: serviceOrderResponses.createServiceOrderErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    createServiceOrderController.handle,
  );

  app.get(
    "/list-service-order",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "List service orders",
        description:
          "Retrieve a paginated list of vehicle service orders with optional search and status filtering",
        querystring: serviceOrderSchemas.listServiceOrder,
        response: {
          200: serviceOrderResponses.serviceOrderList,
          400: serviceOrderResponses.listServiceOrderErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    listServiceOrderController.handle,
  );

  app.get(
    "/export-service-order",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Export service order records (CSV or Excel)",
        description:
          "Export service order records to CSV or Excel. Use query param `format=csv|excel` and optional `search` to filter.",
        querystring: serviceOrderSchemas.exportServiceOrderQuery,
        response: {
          400: serviceOrderResponses.exportServiceOrderErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    exportServiceOrderController.handle,
  );

  app.get(
    "/search-service-order-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Search service orders by business (cursor-based)",
        description:
          "Retrieve service orders as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual service order objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: serviceOrderSchemas.searchServiceOrderBusinessCursor,
        response: {
          200: serviceOrderResponses.searchServiceOrderStreamDescription,
          400: serviceOrderResponses.listServiceOrderBusinessErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    searchServiceOrderCursorController.handle,
  );

  app.get(
    "/search-service-order-by-vehicle/:vehicleId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Search service orders by vehicle (cursor-based)",
        description:
          "Retrieve service orders for a specific vehicle as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual service order objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        params: serviceOrderSchemas.searchServiceOrderByVehicleParams,
        querystring: serviceOrderSchemas.searchServiceOrderByVehicleCursor,
        response: {
          200: serviceOrderResponses.searchServiceOrderStreamDescription,
          400: serviceOrderResponses.listServiceOrderByVehicleErrors,
          403: serviceOrderResponses.vehicleNotBelongBusiness,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    searchServiceOrderByVehicleCursorController.handle,
  );

  app.patch(
    "/update-service-order/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyBranchActive,
        verifyPermission("service_order_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Update a service order",
        description:
          "Update existing service order details including status, parts, labor costs, and completion information",
        params: serviceOrderSchemas.serviceOrderBusinessParams,
        body: serviceOrderSchemas.updateServiceOrder,
        response: {
          200: serviceOrderResponses.serviceOrderUpdated,
          400: serviceOrderResponses.updateServiceOrderErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    updateServiceOrderController.handle,
  );

  app.delete(
    "/delete-service-order/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Delete a service order",
        description:
          "Permanently remove a service order record and all associated maintenance history",
        params: serviceOrderSchemas.serviceOrderBusinessParams,
        response: {
          200: serviceOrderResponses.serviceOrderDeleted,
          400: serviceOrderResponses.deleteServiceOrderErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    deleteServiceOrderController.handle,
  );
}

export { serviceOrderRoutes };
