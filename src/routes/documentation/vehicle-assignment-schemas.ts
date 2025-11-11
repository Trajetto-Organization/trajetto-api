import { z } from "zod";

// Import schemas from src/schemas
import { createVehicleAssignmentSchema } from "@/schemas/create-vehicle-assignment-schema";
import { updateVehicleAssignmentSchema } from "@/schemas/update-vehicle-assignment-schema";
import { listVehicleAssignmentsQuerySchema } from "@/schemas/list-vehicle-assignments-query-schema";
import { vehicleAssignmentParamsSchema } from "@/schemas/vehicle-assignment-params-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

// Param schemas
export const businessIdParamSchema = updateDeleteBusinessSchema;

export const assignmentIdParamSchema = z.object({
  assignmentId: z.string().uuid(),
});

export const getAssignmentParamsSchema = z.object({
  businessId: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

export const updateAssignmentParamsSchema = z.object({
  businessId: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

export const deleteAssignmentParamsSchema = z.object({
  businessId: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

// Body schemas
export { createVehicleAssignmentSchema };
export { updateVehicleAssignmentSchema };

// Query schemas
export { listVehicleAssignmentsQuerySchema };
