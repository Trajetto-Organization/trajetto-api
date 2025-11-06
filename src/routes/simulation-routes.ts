import { FastifyInstance } from "fastify";
import { z } from "zod";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { RunSimulationController } from "@/modules/simulation/usecases/run-simulation/run-simulation-controller";
import { CreateSimulationController } from "@/modules/simulation/usecases/create-simulation/create-simulation-controller";

import { ListSimulationsBusinessController } from "@/modules/simulation/usecases/list-simulations-business/list-simulations-business-controller";
import { GetSimulationController } from "@/modules/simulation/usecases/get-simulation/get-simulation-controller";

import { UpdateSimulationController } from "@/modules/simulation/usecases/update-simulation/update-simulation-controller";
import { DeleteSimulationController } from "@/modules/simulation/usecases/delete-simulation/delete-simulation-controller";

import { ApproveSimulationController } from "@/modules/simulation/usecases/approve-simulation/approve-simulation-controller";

import {
  simulationSchemas,
  simulationResponses,
} from "./documentation/simulation-documentation";

const runSimulationController = new RunSimulationController();
const createSimulationController = new CreateSimulationController();

const listSimulationsController = new ListSimulationsBusinessController();
const getSimulationController = new GetSimulationController();

const updateSimulationController = new UpdateSimulationController();
const deleteSimulationController = new DeleteSimulationController();

const approveSimulationController = new ApproveSimulationController();

async function simulationRoutes(app: FastifyInstance) {
  // POST /simulations/run - Run simulation (sync or async based on routes count)
  app.post(
    "/run",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Run simulation",
        description:
          "Performs a route simulation. If there are more than 5 routes, processes them asynchronously via a worker.",
        body: simulationSchemas.runSimulation,
        response: {
          201: simulationResponses.simulationRunCompleted,
          202: simulationResponses.simulationProcessing,
          400: simulationResponses.runSimulationErrors,
          403: simulationResponses.runSimulationErrors,
          500: simulationResponses.runSimulationErrors,
        },
      },
    },
    runSimulationController.handle,
  );

  // POST /simulations/create - Create simulation (without processing)
  app.post(
    "/create",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Create simulation",
        description:
          "Creates a simulation record without processing the routes.",
        body: simulationSchemas.createSimulation,
        response: {
          201: simulationResponses.simulationCreated,
          400: simulationResponses.createSimulationErrors,
          403: simulationResponses.createSimulationErrors,
          500: simulationResponses.createSimulationErrors,
        },
      },
    },
    createSimulationController.handle,
  );

  // GET /simulations/business/:businessId - List simulations by business
  app.get(
    "/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "List simulations",
        description:
          "Lists all simulations for a company. Returns data in NDJSON (streaming) format with gzip support.",
        params: simulationSchemas.businessIdParam,
        querystring: simulationSchemas.listSimulationsQuery,
        response: {
          200: simulationResponses.simulationList,
          400: simulationResponses.listSimulationsErrors,
          403: simulationResponses.listSimulationsErrors,
          500: simulationResponses.listSimulationsErrors,
        },
      },
    },
    listSimulationsController.handle,
  );

  // GET /simulations/:simulationId - Get simulation
  app.get(
    "/:simulationId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Search simulation",
        description: "Search for a specific simulation by ID.",
        params: simulationSchemas.simulationIdParam,
        response: {
          200: z.object({ simulation: z.any() }),
          400: simulationResponses.getSimulationErrors,
          403: simulationResponses.getSimulationErrors,
          404: simulationResponses.getSimulationErrors,
          500: simulationResponses.getSimulationErrors,
        },
      },
    },
    getSimulationController.handle,
  );

  // PUT /simulations/:simulationId - Update simulation
  app.put(
    "/:simulationId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Update simulation",
        description: "Update the data from a simulation.",
        params: simulationSchemas.simulationIdParam,
        body: simulationSchemas.updateSimulation,
        response: {
          200: simulationResponses.simulationCreated,
          400: simulationResponses.updateSimulationErrors,
          403: simulationResponses.updateSimulationErrors,
          404: simulationResponses.updateSimulationErrors,
          500: simulationResponses.updateSimulationErrors,
        },
      },
    },
    updateSimulationController.handle,
  );

  // DELETE /simulations/:simulationId - Delete simulation
  app.delete(
    "/:simulationId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Delete simulation",
        description: "Delete a simulation and all associated routes.",
        params: simulationSchemas.simulationIdParam,
        response: {
          200: z.object({
            message: z.string(),
            simulation: z.any(),
          }),
          400: simulationResponses.deleteSimulationErrors,
          403: simulationResponses.deleteSimulationErrors,
          404: simulationResponses.deleteSimulationErrors,
          500: simulationResponses.deleteSimulationErrors,
        },
      },
    },
    deleteSimulationController.handle,
  );

  // POST /simulations/:simulationId/approve - Approve simulation (creates real routes)
  app.post(
    "/:simulationId/approve",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("simulation_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["simulation"],
        summary: "Approve simulation",
        description:
          "Approves a completed simulation and creates real routes in the system.",
        params: simulationSchemas.simulationIdParam,
        response: {
          200: simulationResponses.simulationApproved,
          400: simulationResponses.approveSimulationErrors,
          403: simulationResponses.approveSimulationErrors,
          404: simulationResponses.approveSimulationErrors,
          500: simulationResponses.approveSimulationErrors,
        },
      },
    },
    approveSimulationController.handle,
  );
}

export { simulationRoutes };
