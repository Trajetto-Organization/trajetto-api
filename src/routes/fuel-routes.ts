import { FastifyInstance } from "fastify";

import { CreateFuelController } from "@/modules/fuel/usecases/create-fuel/create-fuel-controller";
import { ListFuelController } from "@/modules/fuel/usecases/list-fuel/list-fuel-controller";

import { ListFuelBusinessController } from "@/modules/fuel/usecases/list-fuel-business/list-fuel-business-controller";
import { UpdateFuelController } from "@/modules/fuel/usecases/update-fuel/update-fuel-controller";

import { DeleteFuelController } from "@/modules/fuel/usecases/delete-fuel/delete-fuel-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

const createFuelController = new CreateFuelController();
const listFuelController = new ListFuelController();

const listFuelBusinessController = new ListFuelBusinessController();
const updateFuelController = new UpdateFuelController();

const deleteFuelController = new DeleteFuelController();

async function fuelRoutes(app: FastifyInstance) {
  app.post(
    "/create-fuel/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        description: "Create a new fuel record",
      },
    },
    createFuelController.handle,
  );

  app.get(
    "/list-fuel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        description: "List fuel records",
      },
    },
    listFuelController.handle,
  );

  app.get(
    "/list-fuel-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        description: "List fuel records by business",
      },
    },
    listFuelBusinessController.handle,
  );

  app.patch(
    "/update-fuel/:fuelId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        description: "Update a fuel record",
      },
    },
    updateFuelController.handle,
  );

  app.delete(
    "/delete-fuel/:fuelId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fuel_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fuel"],
        description: "Delete a fuel record",
      },
    },
    deleteFuelController.handle,
  );
}

export { fuelRoutes };
