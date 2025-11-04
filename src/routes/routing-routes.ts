import { FastifyInstance } from "fastify";

import { CalculateRouteController } from "@/modules/routing/usecases/calculate-route/calculate-route-controller";
import { CreateRouteController } from "@/modules/routing/usecases/create-route/create-route-controller";

import { ListRoutesBusinessController } from "@/modules/routing/usecases/list-routes-business/list-routes-business-controller";
import { GetRouteController } from "@/modules/routing/usecases/get-route/get-route-controller";

import { UpdateRouteController } from "@/modules/routing/usecases/update-route/update-route-controller";
import { DeleteRouteController } from "@/modules/routing/usecases/delete-route/delete-route-controller";

import { OptimizeRouteController } from "@/modules/routing/usecases/optimize-route/optimize-route-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  routingSchemas,
  routingResponses,
} from "./documentation/routing-documentation";

const calculateRouteController = new CalculateRouteController();
const createRouteController = new CreateRouteController();

const listRoutesBusinessController = new ListRoutesBusinessController();
const getRouteController = new GetRouteController();

const updateRouteController = new UpdateRouteController();
const deleteRouteController = new DeleteRouteController();

const optimizeRouteController = new OptimizeRouteController();

async function routingRoutes(app: FastifyInstance) {
  // POST /calculate - Calculate route between points
  app.post(
    "/calculate",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Calculate route between points",
        description:
          "Calculate distance, duration and estimated cost for a route between origin and destination with optional waypoints",
        body: routingSchemas.calculateRoute,
        response: {
          200: routingResponses.routeCalculated,
          400: routingResponses.calculateRouteErrors,
          500: routingResponses.internalServerError,
        },
      },
    },
    calculateRouteController.handle,
  );

  // POST /optimize - Optimize point sequence
  app.post(
    "/optimize",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Optimize route sequence",
        description:
          "Optimize the order of multiple coordinates to find the most efficient route (TSP - Traveling Salesman Problem)",
        body: routingSchemas.optimizeRoute,
        response: {
          200: routingResponses.routeOptimized,
          400: routingResponses.optimizeRouteErrors,
          500: routingResponses.internalServerError,
        },
      },
    },
    optimizeRouteController.handle,
  );

  // POST /create - Create and save route
  app.post(
    "/create",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Create and save a route",
        description:
          "Create and persist a route in the database with optional vehicle and driver assignment",
        body: routingSchemas.createRoute,
        response: {
          201: routingResponses.routeCreated,
          400: routingResponses.createRouteErrors,
          500: routingResponses.internalServerError,
        },
      },
    },
    createRouteController.handle,
  );

  // GET /business/:businessId - List routes for a company
  app.get(
    "/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "List routes by business",
        description:
          "Retrieve a paginated list of routes filtered by business with optional search and status filters",
        params: routingSchemas.businessIdParam,
        querystring: routingSchemas.listRoutes,
        response: {
          200: routingResponses.routeList,
          400: routingResponses.listRoutesErrors,
          500: routingResponses.internalServerError,
        },
      },
    },
    listRoutesBusinessController.handle,
  );

  // GET /:routeId/business/:businessId - Search for a specific route
  app.get(
    "/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Get route by ID",
        description:
          "Retrieve detailed information about a specific route including vehicle and driver assignments",
        params: routingSchemas.routeParams,
        response: {
          200: routingResponses.routeDetails,
          400: routingResponses.getRouteErrors,
          404: routingResponses.routeNotFound,
          500: routingResponses.internalServerError,
        },
      },
    },
    getRouteController.handle,
  );

  // PUT /:routeId/business/:businessId - Update route
  app.put(
    "/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Update route",
        description:
          "Update route information including status, vehicle and driver assignments",
        params: routingSchemas.routeParams,
        body: routingSchemas.updateRoute,
        response: {
          200: routingResponses.routeUpdated,
          400: routingResponses.updateRouteErrors,
          404: routingResponses.routeNotFound,
          500: routingResponses.internalServerError,
        },
      },
    },
    updateRouteController.handle,
  );

  // DELETE /:routeId/business/:businessId - Delete route
  app.delete(
    "/:routeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("route_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["routing"],
        summary: "Delete route",
        description: "Permanently delete a route from the system",
        params: routingSchemas.routeParams,
        response: {
          200: routingResponses.routeDeleted,
          400: routingResponses.deleteRouteErrors,
          404: routingResponses.routeNotFound,
          500: routingResponses.internalServerError,
        },
      },
    },
    deleteRouteController.handle,
  );
}

export { routingRoutes };
