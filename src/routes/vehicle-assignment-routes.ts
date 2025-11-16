import { FastifyInstance } from "fastify";

import { CreateVehicleAssignmentController } from "@/modules/vehicle-assignment/usecases/create-vehicle-assignment/create-vehicle-assignment-controller";
import { ListAssignmentsBusinessController } from "@/modules/vehicle-assignment/usecases/list-assignments-business/list-assignments-business-controller";

import { GetAssignmentController } from "@/modules/vehicle-assignment/usecases/get-assignment/get-assignment-controller";
import { UpdateAssignmentController } from "@/modules/vehicle-assignment/usecases/update-assignment/update-assignment-controller";

import { DeleteAssignmentController } from "@/modules/vehicle-assignment/usecases/delete-assignment/delete-assignment-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  vehicleAssignmentSchemas,
  vehicleAssignmentResponses,
} from "./documentation/vehicle-assignment-documentation";

const createAssignmentController = new CreateVehicleAssignmentController();
const listAssignmentsController = new ListAssignmentsBusinessController();

const getAssignmentController = new GetAssignmentController();
const updateAssignmentController = new UpdateAssignmentController();

const deleteAssignmentController = new DeleteAssignmentController();

async function vehicleAssignmentRoutes(app: FastifyInstance) {
  // POST /create-assignment/:businessId - Create vehicle assignment
  app.post(
    "/create-assignment/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_assignment_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-assignment"],
        summary: "Create vehicle assignment",
        description:
          "Creates a vehicle and driver assignment (optional) to run a specific route on a scheduled date.",
        params: vehicleAssignmentSchemas.businessIdParam,
        body: vehicleAssignmentSchemas.createAssignment,
        response: {
          201: vehicleAssignmentResponses.assignmentCreated,
          400: vehicleAssignmentResponses.createAssignmentErrors,
        },
      },
    },
    createAssignmentController.handle,
  );

  // GET /business/:businessId - List assignments by business
  app.get(
    "/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_assignment_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-assignment"],
        summary: "List company responsibilities",
        description:
          "Lists all vehicle assignments for a company with pagination and filters.",
        params: vehicleAssignmentSchemas.businessIdParam,
        querystring: vehicleAssignmentSchemas.listAssignmentsQuery,
        response: {
          200: vehicleAssignmentResponses.assignmentsList,
          400: vehicleAssignmentResponses.listAssignmentsErrors,
        },
      },
    },
    listAssignmentsController.handle,
  );

  // GET /:businessId/:assignmentId - Get assignment details
  app.get(
    "/:businessId/:assignmentId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_assignment_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-assignment"],
        summary: "Search assignment by ID",
        description: "Returns the complete details of a specific assignment.",
        params: vehicleAssignmentSchemas.assignmentParams,
        response: {
          200: vehicleAssignmentResponses.assignmentDetails,
          400: vehicleAssignmentResponses.getAssignmentErrors,
        },
      },
    },
    getAssignmentController.handle,
  );

  // PUT /:businessId/:assignmentId - Update assignment
  app.put(
    "/:businessId/:assignmentId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_assignment_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-assignment"],
        summary: "Update assignment",
        description:
          "Updates the data for an existing assignment (vehicle, driver, date, status, notes).",
        params: vehicleAssignmentSchemas.assignmentParams,
        body: vehicleAssignmentSchemas.updateAssignment,
        response: {
          200: vehicleAssignmentResponses.assignmentUpdated,
          400: vehicleAssignmentResponses.updateAssignmentErrors,
        },
      },
    },
    updateAssignmentController.handle,
  );

  // DELETE /:businessId/:assignmentId - Delete assignment
  app.delete(
    "/:businessId/:assignmentId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("vehicle_assignment_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["vehicle-assignment"],
        summary: "Remove assignment",
        description: "Remove an existing vehicle assignment.",
        params: vehicleAssignmentSchemas.assignmentParams,
        response: {
          200: vehicleAssignmentResponses.assignmentDeleted,
          400: vehicleAssignmentResponses.deleteAssignmentErrors,
        },
      },
    },
    deleteAssignmentController.handle,
  );
}

export { vehicleAssignmentRoutes };
