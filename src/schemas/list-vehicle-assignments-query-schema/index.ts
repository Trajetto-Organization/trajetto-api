import { z } from "zod";

const listVehicleAssignmentsQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20)),
  search: z.string().optional(),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional(),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
});

export { listVehicleAssignmentsQuerySchema };
