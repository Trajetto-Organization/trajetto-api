import { FastifyInstance } from "fastify";

import { CreateServiceOrderController } from "@/modules/service-order/usecases/create-service-order/create-service-order-controller";
import { ListServiceOrderController } from "@/modules/service-order//usecases/list-service-order/list-service-order-controller";

import { UpdateServiceOrderController } from "@/modules/service-order//usecases/update-service-order/update-service-order-controller";
import { DeleteServiceOrderController } from "@/modules/service-order//usecases/delete-service-order/delete-service-order-controller";

import { ListServiceOrderBusinessController } from "@/modules/service-order/usecases/list-service-order-business/list-service-order-business-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  serviceOrderSchemas,
  serviceOrderResponses,
} from "./documentation/service-order-documentation";

const createServiceOrderController = new CreateServiceOrderController();
const listServiceOrderController = new ListServiceOrderController();

const listServiceOrderBusinessController =
  new ListServiceOrderBusinessController();

const updateServiceOrderController = new UpdateServiceOrderController();
const deleteServiceOrderController = new DeleteServiceOrderController();

async function serviceOrderRoutes(app: FastifyInstance) {
  app.post(
    "/create-service-order/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Create a new service order",
        description: "Register a new vehicle maintenance or repair service order with parts, labor, and scheduling details",
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
        description: "Retrieve a paginated list of vehicle service orders with optional search and status filtering",
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
    "/list-service-order-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "List service orders by business",
        description: "Retrieve a paginated list of service orders filtered by specific business with search capabilities",
        querystring: serviceOrderSchemas.listServiceOrderBusinessSchema,
        response: {
          200: serviceOrderResponses.serviceOrderList,
          400: serviceOrderResponses.listServiceOrderBusinessErrors,
          500: serviceOrderResponses.internalServerError,
        },
      },
    },
    listServiceOrderBusinessController.handle,
  );

  app.patch(
    "/update-service-order/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order"],
        summary: "Update a service order",
        description: "Update existing service order details including status, parts, labor costs, and completion information",
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
        description: "Permanently remove a service order record and all associated maintenance history",
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
