import { FastifyInstance } from "fastify";

import { CreateVehicleController } from "@/modules/vehicle/usecases/create-vehicle/create-vehicle-controller";

import { ListVehicleController } from "@/modules/vehicle/usecases/list-vehicle/list-vehicle-controller";
import { ListVehicleBusinessController } from "@/modules/vehicle/usecases/list-vehicle-business/list-vehicle-business-controller";

import { UpdateVehicleController } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-controller";
import { DeleteVehicleController } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleSchemas,
  vehicleResponses,
} from "./documentation/vehicle-documentation";
import { GetVehicleController } from "@/modules/vehicle/usecases/get-vehicle/get-vehicle-controller";

const createVehicleController = new CreateVehicleController();
const listVehicleController = new ListVehicleController();

const listVehicleBusinessController = new ListVehicleBusinessController();
const getVehicleController = new GetVehicleController();

const updateVehicleController = new UpdateVehicleController();
const deleteVehicleController = new DeleteVehicleController();

async function vehicleRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        description: "Create a new vehicle",
        params: vehicleSchemas.businessIdParam,
        body: vehicleSchemas.createVehicle,
        response: {
          201: vehicleResponses.vehicleCreated,
          400: vehicleResponses.createVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    createVehicleController.handle,
  );

  app.get(
    "/list-vehicle",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        description: "List vehicles",
        querystring: vehicleSchemas.listVehicle,
        response: {
          200: vehicleResponses.vehicleList,
          400: vehicleResponses.listVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    listVehicleController.handle,
  );

  app.get(
    "/list-vehicle-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        description: "List vehicle business",
        querystring: vehicleSchemas.listVehicleBusinessSchema,
        response: {
          200: vehicleResponses.vehicleList,
          400: vehicleResponses.listVehicleBusinessErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    listVehicleBusinessController.handle,
  );

  app.get(
    "/get-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "read")],
    },
    getVehicleController.handle,
  );

  app.patch(
    "/update-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        description: "Update vehicle information",
        params: vehicleSchemas.vehicleBusinessParams,
        body: vehicleSchemas.updateVehicle,
        response: {
          200: vehicleResponses.vehicleUpdated,
          400: vehicleResponses.updateVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    updateVehicleController.handle,
  );

  app.delete(
    "/delete-vehicle/:vehicleId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle"],
        description: "Delete a vehicle",
        params: vehicleSchemas.vehicleBusinessParams,
        response: {
          200: vehicleResponses.vehicleDeleted,
          400: vehicleResponses.deleteVehicleErrors,
          500: vehicleResponses.internalServerError,
        },
      },
    },
    deleteVehicleController.handle,
  );
}

export { vehicleRoutes };
