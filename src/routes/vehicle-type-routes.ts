import { FastifyInstance } from "fastify";

import { CreateVehicleTypeController } from "@/modules/vehicle-type/usecases/create-vehicle-type/create-vehicle-type-controller";
import { ListVehicleTypeController } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-controller";

import { UpdateVehicleTypeController } from "@/modules/vehicle-type/usecases/update-vehicle-type/update-vehicle-type-controller";
import { DeleteVehicleTypeController } from "@/modules/vehicle-type/usecases/delete-vehicle-type/delete-vehicle-type-controller";

import { ListVehicleTypeBusinessController } from "@/modules/vehicle-type/usecases/list-vehicle-type-business/list-vehicle-type-business-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleTypeSchemas,
  vehicleTypeResponses,
} from "./documentation/vehicle-type-documentation";

const createVehicleTypeController = new CreateVehicleTypeController();
const listVehicleTypeController = new ListVehicleTypeController();

const listVehicleTypeBusinessController =
  new ListVehicleTypeBusinessController();

const updateVehicleTypeController = new UpdateVehicleTypeController();
const deleteVehicleTypeController = new DeleteVehicleTypeController();

async function vehicleTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-vehicle-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicleType"],
        description: "Create a new vehicle type",
        params: vehicleTypeSchemas.businessIdParam,
        body: vehicleTypeSchemas.createVehicleType,
        response: {
          201: vehicleTypeResponses.vehicleTypeCreated,
          400: vehicleTypeResponses.createVehicleTypeErrors,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    createVehicleTypeController.handle,
  );

  app.get(
    "/list-vehicle-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicleType"],
        description: "List vehicle types",
        querystring: vehicleTypeSchemas.listVehicleType,
        response: {
          200: vehicleTypeResponses.vehicleTypeList,
          400: vehicleTypeResponses.listVehicleTypeErrors,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    listVehicleTypeController.handle,
  );

  app.get(
    "/list-vehicle-type-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicleType"],
        description: "List vehicle type business",
        querystring: vehicleTypeSchemas.listVehicleTypeBusiness,
        response: {
          200: vehicleTypeResponses.vehicleTypeList,
          400: vehicleTypeResponses.listVehicleTypeBusinessErrors,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    listVehicleTypeBusinessController.handle,
  );

  app.patch(
    "/update-vehicle-type/:vehicleTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicleType"],
        description: "Update vehicle type information",
        params: vehicleTypeSchemas.vehicleTypeBusinessParams,
        body: vehicleTypeSchemas.updateVehicleType,
        response: {
          200: vehicleTypeResponses.vehicleTypeUpdated,
          400: vehicleTypeResponses.updateVehicleTypeErrors,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    updateVehicleTypeController.handle,
  );

  app.delete(
    "/delete-vehicle-type/:vehicleTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_type_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicleType"],
        description: "Delete a vehicle type",
        params: vehicleTypeSchemas.vehicleTypeBusinessParams,
        response: {
          200: vehicleTypeResponses.vehicleTypeDeleted,
          400: vehicleTypeResponses.deleteVehicleTypeErrors,
          403: vehicleTypeResponses.vehicleTypeNotBelongBusinessError,
          500: vehicleTypeResponses.internalServerError,
        },
      },
    },
    deleteVehicleTypeController.handle,
  );
}

export { vehicleTypeRoutes };
