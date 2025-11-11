import { z } from "zod";

const updateVehicleAssignmentSchema = z.object({
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .optional(),
  driverId: z
    .string()
    .uuid("O ID do motorista deve ser um UUID válido.")
    .nullable()
    .optional(),
  scheduledDate: z
    .string()
    .datetime("A data agendada deve estar no formato ISO 8601.")
    .optional(),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional(),
  notes: z.string().nullable().optional(),
});

export { updateVehicleAssignmentSchema };
